use super::{model::*, secure_fs::Root};
use crate::protocol::{Failure,validate_path,SOURCE_DOCUMENT_BYTES,SOURCE_SNAPSHOT_BYTES};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, fs::File, io::{Read, Write}, path::{Path, PathBuf}, sync::Arc};

pub struct Grant { pub id: String, pub kind: &'static str, pub path: PathBuf, pub root: Arc<Root>, pub exact: Option<String> }
impl Grant {
    pub fn dto(&self) -> Value { json!({"id":self.id,"kind":self.kind,"path":self.root.path(),"exact":self.exact}) }
    pub fn relative(&self, path: &str) -> Result<String, Failure> {
        let relative = if Path::new(path).is_absolute() { Path::new(path).strip_prefix(self.root.path()).map_err(|_| failure("denied_path", "Dependency is outside its grant"))?.to_str().ok_or_else(|| failure("denied_path", "Non-UTF8 dependency path"))?.to_owned() } else { path.to_owned() };
        validate_path(&relative)?;
        if self.exact.as_ref().is_some_and(|p| p != &relative) { return Err(failure("denied_path", "Dependency is outside its exact-file grant")); }
        Ok(relative)
    }
}
pub fn boot_grants(resource_dir: &Path, event: &super::watch::EventSink) -> Result<Vec<Grant>, Failure> {
    let mut grants = Vec::new();
    let library = resource_dir.join("library");
    if library.exists() { let root = Arc::new(Root::open(&library)?); grants.push(Grant { id:"library".into(),kind:"library",path:root.path().to_owned(),root,exact:None }); }
    let installed = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from).filter(|path| path.is_absolute()).map(|path| path.join(".local/share")))
        .map(|path| path.join("muz/contrib"));
    let explicit = std::env::var_os("MUZ_CONTRIB_DIR").map(PathBuf::from);
    if explicit.as_ref().is_some_and(|path| !path.is_dir()) {
        event(json!({"kind":"failure","project":null,"failure":failure("missing_module","MUZ_CONTRIB_DIR does not name an installed library directory")}));
    }
    // Locally built releases retain the sibling checkout as an optional install
    // source. Packaged apps still work elsewhere through the normal muz install.
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../muz-core/contrib");
    if let Some(path) = contrib_installation(explicit, checkout, installed) {
        let root = Arc::new(Root::open(&path.canonicalize()?)?);
        grants.push(Grant { id:"contrib".into(),kind:"library",path:root.path().to_owned(),root,exact:None });
    }
    let config = muz::plugins::config_path();
    if config.exists() {
        let canonical = config.canonicalize()?;
        let parent = canonical.parent().ok_or_else(|| failure("denied_path", "Plugin config has no parent"))?;
        let root = Arc::new(Root::open(parent)?);
        let name = canonical.file_name().and_then(|v| v.to_str()).ok_or_else(|| failure("denied_path", "Plugin config filename is not UTF-8"))?.to_owned();
        if let Some(file) = root.read(&name, SOURCE_DOCUMENT_BYTES)? {
            // Invalid machine configuration must not prevent editing or recovery.
            // The engine still parses this exact granted config and rejects builds.
            let parsed = serde_json::from_slice::<Value>(&file.bytes).map_err(|e| failure("invalid_source",format!("Invalid plugin configuration: {e}"))).and_then(|value| {
                if value.as_object().is_some_and(|object| object.len() <= MAX_FILES) { Ok(value) } else { Err(failure("invalid_source","Plugin aliases must be a bounded JSON object")) }
            });
            let value = match parsed { Ok(value) => value, Err(error) => { event(json!({"kind":"failure","project":null,"failure":error})); Value::Null } };
            for alias in value.as_object().into_iter().flat_map(|object| object.values()) {
                let Some(path) = alias["path"].as_str() else { event(json!({"kind":"failure","project":null,"failure":failure("invalid_source","Plugin alias needs a path")})); continue; };
                let path = if Path::new(path).is_absolute() { PathBuf::from(path) } else { config.parent().unwrap_or(Path::new(".")).join(path) };
                if path.exists() { add_plugin_grant(&mut grants, &path)?; }
            }
        }
        grants.push(Grant { id:"plugin-config".into(),kind:"config",path:root.path().to_owned(),root,exact:Some(name) });
    }
    let mut paths = vec![PathBuf::from("/usr/lib/vst3"),PathBuf::from("/usr/lib/clap"),PathBuf::from("/usr/local/lib/vst3"),PathBuf::from("/usr/local/lib/clap")];
    if let Some(home) = std::env::var_os("HOME") { paths.push(PathBuf::from(&home).join(".vst3")); paths.push(PathBuf::from(home).join(".clap")); }
    for path in paths { if path.exists() { add_plugin_grant(&mut grants, &path)?; } }
    Ok(grants)
}
fn contrib_installation(explicit: Option<PathBuf>, checkout: PathBuf, installed: Option<PathBuf>) -> Option<PathBuf> {
    explicit.into_iter().chain(std::iter::once(checkout)).chain(installed).find(|path| path.is_dir())
}
fn add_plugin_grant(grants: &mut Vec<Grant>, path: &Path) -> Result<(), Failure> {
    let canonical = path.canonicalize()?;
    if grants.iter().any(|g| g.path == canonical) { return Ok(()); }
    let (root, exact) = if canonical.is_dir() { (Arc::new(Root::open(&canonical)?),None) } else {
        let parent = canonical.parent().ok_or_else(|| failure("denied_path", "Plugin has no parent"))?;
        (Arc::new(Root::open(parent)?),Some(canonical.file_name().and_then(|v| v.to_str()).ok_or_else(|| failure("denied_path", "Plugin filename is not UTF-8"))?.to_owned()))
    };
    grants.push(Grant { id:format!("plugin:{}",digest(canonical.as_os_str().as_encoded_bytes())),kind:"plugin",path:canonical,root,exact }); Ok(())
}
pub fn read_workspace(root: Arc<Root>, persisted: bool, project: String) -> Result<Workspace, Failure> {
    let entries = root.list(MAX_FILES)?;
    let mut settings = None; let mut settings_base = None; let mut settings_version = None;
    let mut files = BTreeMap::new(); let mut resources = Vec::new(); let mut total = 0usize;
    for entry in entries {
        if entry.path == SETTINGS || text_kind(&entry.path).is_some() {
            let file = root.read(&entry.path, SOURCE_DOCUMENT_BYTES)?.ok_or_else(|| failure("source_conflict", "File disappeared during project opening"))?;
            total = total.checked_add(file.bytes.len()).ok_or_else(|| failure("too_large", "Project size overflow"))?;
            if total > SOURCE_SNAPSHOT_BYTES { return Err(failure("too_large", "Project sources exceed 64 MiB")); }
            let text = String::from_utf8(file.bytes).map_err(|_| failure("invalid_source", format!("{} is not UTF-8", entry.path)))?;
            if entry.path == SETTINGS { let parsed: Settings = serde_json::from_str(&text).map_err(|e| failure("invalid_source", format!("Invalid muzpad.json: {e}")))?; parsed.validate()?; settings = Some(parsed); settings_base = Some(text); settings_version = Some(file.version); }
            else { let id = stable_file_id(&project, &entry.path); files.insert(id.clone(), Buffer { id,path:entry.path,text:Some(text.clone()),base:Some(text),version:0,disk_version:Some(file.version),conflict:None,history:Vec::new() }); }
        } else { resources.push(resource(&project, &entry.path, entry.bytes, None, false)); }
    }
    let settings = settings.unwrap_or_else(|| Settings { title:root.path().file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Project".into()),entry:default_entry(files.values().filter(|f| text_kind(&f.path)==Some("source")).map(|f|f.path.as_str())),entries:None });
    Ok(Workspace { project,epoch:opaque(),root,persisted,trusted:true,gist:None,settings,settings_base,settings_version,settings_conflict:None,source_version:0,disk_generation:0,files,resources,asset_origin:None,acknowledged_source:0,settings_history:Vec::new(),recent_saves:BTreeMap::new() })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Imported {
    pub settings: Settings, pub files: Vec<ImportedFile>, pub assets: Vec<ImportedAsset>,
    #[serde(default, deserialize_with = "deserialize_gist")]
    pub gist: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportedFile { pub path: String, pub text: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportedAsset { pub path: String, pub format: String, pub base64: String, #[serde(skip)] pub bytes: Option<Vec<u8>> }
pub fn populate_import(workspace: &mut Workspace, imported: Imported, journal: &Path) -> Result<(), Failure> {
    imported.settings.validate()?;
    if imported.files.len() + imported.assets.len() > MAX_FILES { return Err(failure("resource_budget", "Too many imported files")); }
    let mut paths = BTreeSet::new(); let mut sources = 0usize; let mut assets = 0u64;
    for file in imported.files {
        validate_path(&file.path)?;
        if file.path == SETTINGS || text_kind(&file.path).is_none() || !paths.insert(file.path.clone()) { return Err(failure("invalid_source", "Invalid or duplicate imported source path")); }
        sources += file.text.len();
        if file.text.len() > SOURCE_DOCUMENT_BYTES || sources > SOURCE_SNAPSHOT_BYTES { return Err(failure("too_large", "Imported sources exceed the host budget")); }
        let id = stable_file_id(&workspace.project, &file.path);
        workspace.files.insert(id.clone(),Buffer { id,path:file.path,text:Some(file.text),version:1,base:None,disk_version:None,conflict:None,history:Vec::new() });
    }
    for asset in imported.assets {
        validate_path(&asset.path)?;
        let kind = resource_kind(&asset.path);
        if (asset.bytes.is_none() && !matches!(asset.format.as_str(), "midi" | "wav" | "flac")) || asset.format != kind || !paths.insert(asset.path.clone()) { return Err(failure("invalid_source", "Invalid imported asset path or format")); }
        if asset.base64.len() as u64 > MAX_ASSETS * 4 / 3 + 4 { return Err(failure("too_large", "Imported asset exceeds the host budget")); }
        let bytes = match asset.bytes { Some(bytes) => bytes, None => base64::engine::general_purpose::STANDARD.decode(asset.base64).map_err(|_| failure("invalid_source", "Invalid asset base64"))? };
        assets = assets.checked_add(bytes.len() as u64).ok_or_else(|| failure("too_large", "Asset size overflow"))?;
        if assets > MAX_ASSETS { return Err(failure("too_large", "Imported assets exceed 256 MiB")); }
        let version = workspace.root.write(&asset.path,Some(&bytes),None,journal)?;
        let mut descriptor = resource(&workspace.project,&asset.path,bytes.len() as u64,version,false); descriptor["pendingSave"] = json!(true); workspace.resources.push(descriptor);
    }
    workspace.settings = imported.settings; workspace.gist = imported.gist; workspace.source_version = 1; Ok(())
}
pub fn import_zip(path: &Path) -> Result<Imported, Failure> {
    let mut archive = zip::ZipArchive::new(File::open(path)?).map_err(|e| failure("invalid_source", format!("Invalid ZIP: {e}")))?;
    if archive.len() > MAX_FILES { return Err(failure("resource_budget", "ZIP contains too many entries")); }
    let mut files = Vec::new(); let mut assets = Vec::new(); let mut paths = BTreeSet::new(); let mut total = 0u64; let mut settings = None;
    let mut source_bytes = 0usize; let mut asset_bytes = 0u64;
    for index in 0..archive.len() {
        let mut item = archive.by_index(index).map_err(|e| failure("invalid_source", e.to_string()))?;
        let path = item.name().to_owned();
        if item.is_dir() { validate_path(path.trim_end_matches('/'))?; continue; }
        validate_path(&path)?;
        if item.unix_mode().is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000) || !paths.insert(path.clone()) { return Err(failure("denied_path", "ZIP has links, special files, or duplicate paths")); }
        total = total.checked_add(item.size()).ok_or_else(|| failure("too_large", "ZIP size overflow"))?;
        if total > MAX_ASSETS + SOURCE_SNAPSHOT_BYTES as u64 { return Err(failure("too_large", "ZIP exceeds the import budget")); }
        let limit = if text_kind(&path).is_some() || path == SETTINGS { SOURCE_DOCUMENT_BYTES as u64 } else { MAX_ASSETS };
        if item.size() > limit { return Err(failure("too_large", "ZIP entry exceeds the host budget")); }
        let mut bytes = Vec::new(); item.by_ref().take(limit + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > limit { return Err(failure("too_large", "ZIP expanded beyond its advertised size")); }
        if path == SETTINGS || text_kind(&path).is_some() {
            source_bytes = source_bytes.checked_add(bytes.len()).ok_or_else(|| failure("too_large","ZIP source size overflow"))?;
            if source_bytes > SOURCE_SNAPSHOT_BYTES { return Err(failure("too_large","ZIP sources exceed 64 MiB")); }
        } else {
            asset_bytes = asset_bytes.checked_add(bytes.len() as u64).ok_or_else(|| failure("too_large","ZIP asset size overflow"))?;
            if asset_bytes > MAX_ASSETS { return Err(failure("too_large","ZIP assets exceed 256 MiB")); }
        }
        if path == SETTINGS { settings = Some(serde_json::from_slice::<Settings>(&bytes).map_err(|e| failure("invalid_source", format!("Invalid muzpad.json: {e}")))?); }
        else if text_kind(&path).is_some() { files.push(ImportedFile { path,text:String::from_utf8(bytes).map_err(|_| failure("invalid_source", "ZIP source is not UTF-8"))? }); }
        else {
            let format = resource_kind(&path);
            assets.push(ImportedAsset { path,format:format.into(),base64:String::new(),bytes:Some(bytes) });
        }
    }
    let settings = settings.unwrap_or_else(|| Settings { title:path.file_stem().map(|v| v.to_string_lossy().into_owned()).unwrap_or_else(|| "Imported project".into()),entry:default_entry(files.iter().filter(|f|text_kind(&f.path)==Some("source")).map(|f|f.path.as_str())),entries:None });
    Ok(Imported { settings,files,assets,gist:None })
}
pub fn write_archive(workspace: &Workspace, path: &Path) -> Result<(), Failure> {
    let file = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    let mut archive = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).unix_permissions(0o600);
    let zip_error = |e: zip::result::ZipError| failure("file_write_failed", e.to_string());
    archive.start_file(SETTINGS, options).map_err(zip_error)?; archive.write_all(&workspace.settings.bytes()?)?;
    for source in workspace.files.values() { if let Some(text) = &source.text { archive.start_file(&source.path,options).map_err(zip_error)?; archive.write_all(text.as_bytes())?; } }
    let mut total = 0u64;
    for descriptor in &workspace.resources {
        if descriptor["linked"] == true { continue; }
        let source_path = descriptor["path"].as_str().ok_or_else(|| failure("invalid_source", "Resource has no path"))?;
        let root = if descriptor["pendingSave"] == true { workspace.asset_origin.as_ref().unwrap_or(&workspace.root) } else { &workspace.root };
        let content = root.read(source_path, MAX_ASSETS as usize)?.ok_or_else(|| failure("changed_asset", format!("Missing archive resource: {source_path}")))?;
        total = total.checked_add(content.bytes.len() as u64).ok_or_else(|| failure("too_large", "Archive asset size overflow"))?;
        if total > MAX_ASSETS { return Err(failure("too_large", "Project-owned archive assets exceed 256 MiB")); }
        if descriptor["version"].as_str().is_some_and(|v| v != content.version) { return Err(failure("changed_asset", format!("Archive resource changed: {source_path}"))); }
        archive.start_file(source_path,options).map_err(zip_error)?; archive.write_all(&content.bytes)?;
    }
    let file = archive.finish().map_err(zip_error)?; file.sync_all()?; Ok(())
}
fn default_entry<'a>(paths: impl Iterator<Item=&'a str>) -> String {
    let paths: BTreeSet<_> = paths.collect();
    ["song.muz","main.muz"].into_iter().find(|path|paths.contains(path))
        .or_else(||paths.first().copied()).unwrap_or("song.muz").to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_plugin_dto_keeps_exact_child_authority() {
        let installation=tempfile::tempdir().unwrap();let project=tempfile::tempdir().unwrap();
        let plugin=installation.path().join("Surge.clap");
        std::fs::write(&plugin,b"fixture").unwrap();
        std::fs::write(installation.path().join("other.clap"),b"not granted").unwrap();
        let mut grants=Vec::new();add_plugin_grant(&mut grants,&plugin).unwrap();
        let dto=grants[0].dto();
        assert_eq!(dto["path"],json!(installation.path().canonicalize().unwrap()));
        assert_eq!(dto["exact"],"Surge.clap");
        let child=crate::engine::sources::Grants::new(json!([
            {"id":"project","kind":"project","path":project.path().canonicalize().unwrap()},
            dto
        ]), false).unwrap();
        child.plugin(&plugin).unwrap();
        assert!(child.open(&installation.path().join("other.clap")).is_err());
    }

    #[test]
    fn contrib_uses_explicit_then_checkout_then_normal_installation() {
        let root = tempfile::tempdir().unwrap();
        let explicit = root.path().join("explicit");
        let checkout = root.path().join("checkout/contrib");
        let installed = root.path().join("data/muz/contrib");
        std::fs::create_dir_all(&installed).unwrap();
        assert_eq!(contrib_installation(None, checkout.clone(), Some(installed.clone())), Some(installed.clone()));
        std::fs::create_dir_all(&checkout).unwrap();
        assert_eq!(contrib_installation(None, checkout.clone(), Some(installed.clone())), Some(checkout.clone()));
        std::fs::create_dir_all(&explicit).unwrap();
        assert_eq!(contrib_installation(Some(explicit.clone()), checkout.clone(), Some(installed)), Some(explicit));
        assert_eq!(contrib_installation(None, checkout.clone(), None), Some(checkout));
        assert!(contrib_installation(None, root.path().join("missing"), None).is_none());
    }
}
