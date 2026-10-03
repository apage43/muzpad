use crate::protocol::{Failure, CHUNK_BYTES, SOURCE_DOCUMENT_BYTES, SOURCE_SNAPSHOT_BYTES};
use base64::Engine;
use muz::assets::{AssetReader, AssetResolver, AssetSnapshot};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use parking_lot::Mutex;
use std::{collections::BTreeMap, fs::File, io::{Read, Write}, path::{Component, Path, PathBuf}, sync::{Arc, Weak, LazyLock, atomic::{AtomicBool, Ordering}}};

const ASSET_BUDGET: u64 = 512 * 1024 * 1024;
pub fn temporary_directory()->std::io::Result<tempfile::TempDir>{
    if let Some(root)=std::env::var_os("MUZPAD_ENGINE_CACHE_DIR"){
        tempfile::Builder::new().prefix("muzpad-").tempdir_in(root)
    }else{
        tempfile::Builder::new().prefix("muzpad-").tempdir()
    }
}
#[derive(Clone, Deserialize)]
pub struct Grant { pub id: String, pub kind: String, pub path: PathBuf, #[serde(default)] pub exact: Option<PathBuf> }
pub struct Grants { pub entries: Vec<Grant>, roots: Vec<File>, pub project_root: PathBuf }
impl Grants {
    pub fn new(value: Value) -> Result<Arc<Self>, Failure> {
        let entries: Vec<Grant> = serde_json::from_value(value).map_err(|e| failure("denied_path", e.to_string()))?;
        if entries.len() > 128 { return Err(failure("resource_budget", "Too many read grants")); }
        let mut roots = Vec::new();
        let mut project_root = None;
        for grant in &entries {
            if !["project", "library", "config", "plugin", "assetCache"].contains(&grant.kind.as_str()) || !grant.path.is_absolute() {
                return Err(failure("denied_path", "Invalid native grant"));
            }
            let canonical = grant.path.canonicalize().map_err(io_failure)?;
            if canonical != grant.path || !canonical.is_dir() { return Err(failure("denied_path", "Grant must be a canonical directory")); }
            if let Some(exact) = &grant.exact {
                if !matches!(grant.kind.as_str(), "config" | "plugin") || exact.components().count() != 1
                    || !matches!(exact.components().next(), Some(Component::Normal(_)))
                    || exact.to_string_lossy().contains(['\0', '\\']) {
                    return Err(failure("denied_path", "Invalid exact-file grant"));
                }
            }
            roots.push(File::open(&canonical).map_err(io_failure)?);
            if grant.kind == "project" { project_root = Some(canonical); }
        }
        let project_root = project_root.ok_or_else(|| failure("grant_required", "Project read root is missing"))?;
        Ok(Arc::new(Self { entries, roots, project_root }))
    }
    fn locate(&self, path: &Path) -> Result<(usize, PathBuf), Failure> {
        let path = lexical(path)?;
        self.entries.iter().enumerate().filter_map(|(i, g)| path.strip_prefix(&g.path).ok()
            .filter(|relative| g.exact.as_ref().is_none_or(|exact| *relative == exact.as_path()))
            .map(|p| (i,p.to_owned())))
            .max_by_key(|(i,_)| self.entries[*i].path.components().count())
            .ok_or_else(|| path_failure("grant_required",&path,format!("Read permission required for {}",path.display())))
    }
    pub fn canonical(&self, path: &Path) -> Result<PathBuf, Failure> {
        self.locate(path)?;
        let canonical = path.canonicalize().map_err(io_failure)?;
        self.locate(&canonical)?;
        Ok(canonical)
    }
    pub fn open(&self, path: &Path) -> Result<(File, Value), Failure> {
        let (index, relative) = self.locate(path)?;
        let file = open_beneath(&self.roots[index], &relative).map_err(io_failure)?;
        if !file.metadata().map_err(io_failure)?.is_file() { return Err(failure("denied_path", "Only regular files may be read")); }
        Ok((file,json!({"grant":self.entries[index].id,"path":relative.to_string_lossy()})))
    }
    pub fn plugin(&self, path: &Path) -> Result<(), Failure> {
        let canonical = self.canonical(path)?;
        if !self.entries.iter().any(|g| g.kind == "plugin" && canonical.strip_prefix(&g.path).ok()
            .is_some_and(|relative| g.exact.as_ref().is_none_or(|exact| relative == exact))) {
            return Err(path_failure("grant_required",&canonical,format!("Plugin installation grant required: {}",canonical.display())));
        }
        Ok(())
    }
    pub fn contrib(&self) -> Result<PathBuf, Failure> {
        if let Some(grant)=self.entries.iter().find(|g|g.id=="contrib"&&g.kind=="library"){return Ok(grant.path.clone());}
        self.entries.iter().filter(|g| g.id=="library"&&g.kind=="library").map(|g| g.path.join("contrib"))
            .find(|p| p.is_dir()).ok_or_else(|| failure("grant_required", "Contrib library grant is unavailable"))
    }
}
#[cfg(target_os = "linux")]
fn open_beneath(root: &File, path: &Path) -> std::io::Result<File> {
    use std::os::{fd::{AsRawFd, FromRawFd}, unix::ffi::OsStrExt};
    #[repr(C)] struct OpenHow { flags: u64, mode: u64, resolve: u64 }
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput,"NUL path"))?;
    let how = OpenHow { flags: (libc::O_RDONLY | libc::O_CLOEXEC) as u64, mode: 0, resolve: 0x08 | 0x02 };
    let fd = unsafe { libc::syscall(libc::SYS_openat2, root.as_raw_fd(), name.as_ptr(), &how, std::mem::size_of::<OpenHow>()) };
    if fd < 0 { return Err(std::io::Error::last_os_error()); }
    Ok(unsafe { File::from_raw_fd(fd as i32) })
}
#[cfg(not(target_os = "linux"))]
fn open_beneath(_: &File, _: &Path) -> std::io::Result<File> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported,"Secure native source reads require Linux openat2"))
}
pub fn lexical(path: &Path) -> Result<PathBuf, Failure> {
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part { Component::ParentDir => { if !normalized.pop() { return Err(failure("denied_path","Path escapes root")); } }, Component::CurDir => {}, c => normalized.push(c.as_os_str()) }
    }
    if !normalized.is_absolute() || path.as_os_str().len()>4096 || path.to_string_lossy().contains(['\0','\\'])
        || path.components().any(|part|matches!(part,Component::Normal(name) if name.len()>255)){
        return Err(failure("denied_path","Invalid native source path"));
    }
    Ok(normalized)
}
pub fn failure(code: &str, message: impl Into<String>) -> Failure { Failure::new(code,"compile",message) }
fn io_failure(error: std::io::Error) -> Failure {
    failure(match error.kind() { std::io::ErrorKind::PermissionDenied=>"permission_denied",std::io::ErrorKind::NotFound=>"missing_module",_=>"denied_path" },error.to_string())
}
fn path_failure(code:&str,path:&Path,message:impl Into<String>)->Failure{
    let mut failure=failure(code,message);failure.path=Some(path.to_string_lossy().into_owned());failure
}
fn remember<T>(result:Result<T,Failure>,slot:&Mutex<Option<Failure>>)->Result<T,Failure>{
    if let Err(failure)=&result{*slot.lock()=Some(failure.clone());}result
}
fn read_stable(grants: &Grants, path: &Path, limit: usize) -> Result<(Vec<u8>,Value,(u64,u128)), Failure> {
    let (mut file,mut dependency) = grants.open(path)?;
    let before = file.metadata().map_err(io_failure)?;
    if before.len() > limit as u64 { return Err(failure("resource_budget","Resource exceeds immutable capture budget")); }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file).take(limit as u64 + 1).read_to_end(&mut bytes).map_err(io_failure)?;
    let after = file.metadata().map_err(io_failure)?;
    if bytes.len() > limit || before.len() != after.len() || before.modified().ok() != after.modified().ok() || bytes.len() as u64 != before.len() {
        return Err(failure("source_conflict","Resource changed while being captured"));
    }
    let digest = Sha256::digest(&bytes);
    dependency["version"] = json!(hex::encode(digest));
    let version = (bytes.len() as u64, u64::from_le_bytes(digest[..8].try_into().unwrap()) as u128);
    Ok((bytes,dependency,version))
}

#[derive(Clone, Serialize, Deserialize)]
struct Pin { identity: PathBuf, file: String, version: (u64,u128), dependency: Value }
#[derive(Clone, Serialize, Deserialize)]
struct PluginPin { path: PathBuf, version: String, bytes: u64 }
struct PluginBundle { _directory:tempfile::TempDir, root:PathBuf, files:Vec<PluginPin>, bytes:u64 }
static PLUGINS:LazyLock<Mutex<BTreeMap<String,Weak<PluginBundle>>>>=LazyLock::new(||Mutex::new(BTreeMap::new()));
struct AssetState { pins: BTreeMap<PathBuf, Pin>, aliases:BTreeMap<PathBuf,PathBuf>, overlay:BTreeMap<PathBuf,Arc<str>>, project_overlay:bool, plugins: Vec<PluginPin>, bundles:Vec<Arc<PluginBundle>>, total: u64, frozen: bool }
pub struct PinnedAssets { grants: Option<Arc<Grants>>, directory: tempfile::TempDir, state: Mutex<AssetState>, error:Mutex<Option<Failure>>, decoded:Arc<muz::audio_file::DecodedCache> }
impl PinnedAssets {
    pub fn new(grants: Arc<Grants>) -> Result<Arc<Self>, Failure> {
        Ok(Arc::new(Self { grants: Some(grants), directory: temporary_directory().map_err(io_failure)?, state: Mutex::new(AssetState { pins:BTreeMap::new(),aliases:BTreeMap::new(),overlay:BTreeMap::new(),project_overlay:false,plugins:Vec::new(),bundles:Vec::new(),total:0,frozen:false }),error:Mutex::new(None),decoded:Arc::new(Default::default()) }))
    }
    pub fn freeze(&self) {let mut state=self.state.lock();state.frozen=true;state.overlay.clear();}
    pub fn dependencies(&self) -> Vec<Value> { self.state.lock().pins.values().map(|p| p.dependency.clone()).collect() }
    pub fn take_failure(&self)->Option<Failure>{self.error.lock().take()}
    fn pin(&self, path: &Path) -> anyhow::Result<Pin> {
        let mut state = self.state.lock();
        if let Some(pin) = state.pins.get(path) { return Ok(pin.clone()); }
        if state.frozen { return Err(failure("changed_asset",format!("Resource was not captured by accepted revision: {}",path.display())).into()); }
        let grants = self.grants.as_ref().ok_or_else(|| failure("changed_asset","Missing pinned resource"))?;
        if let Some(text)=state.overlay.get(path).cloned(){
            if text.len() as u64>ASSET_BUDGET-state.total{return Err(failure("resource_budget","Accepted text asset cache budget exceeded").into());}
            let (index,relative)=grants.locate(path)?;let hash=Sha256::digest(text.as_bytes());
            let dependency=json!({"grant":grants.entries[index].id,"path":relative.to_string_lossy(),"version":hex::encode(hash)});
            let version=(text.len() as u64,u64::from_le_bytes(hash[..8].try_into().unwrap()) as u128);
            let file=format!("asset-{}",state.pins.len());
            let mut output=File::create(self.directory.path().join(&file))?;output.write_all(text.as_bytes())?;output.sync_all()?;
            let pin=Pin{identity:path.to_owned(),file,version,dependency};state.total+=version.0;state.pins.insert(path.to_owned(),pin.clone());return Ok(pin);
        }
        let (mut input,mut dependency)=remember(grants.open(path),&self.error)?;
        let before=input.metadata()?;
        if before.len()>ASSET_BUDGET-state.total{return Err(failure("resource_budget","Accepted asset cache exceeds 512 MiB").into());}
        let file = format!("asset-{}",state.pins.len());
        let mut output = File::create(self.directory.path().join(&file))?;
        let mut digest=Sha256::new();let mut bytes=0u64;let mut chunk=[0u8;65536];
        loop {
            muz::host::check_cancelled()?;
            let n=input.read(&mut chunk)?;if n==0{break;}
            bytes+=n as u64;if bytes>before.len(){return Err(failure("changed_asset","Asset grew during capture").into());}
            digest.update(&chunk[..n]);output.write_all(&chunk[..n])?;
        }
        let after=input.metadata()?;
        if before.len()!=bytes||before.modified()?!=after.modified()?||after.len()!=bytes{return Err(failure("changed_asset","Asset changed during capture").into());}
        let digest=digest.finalize();dependency["version"]=json!(hex::encode(digest));
        let version=(bytes,u64::from_le_bytes(digest[..8].try_into().unwrap()) as u128);
        output.sync_all()?;
        state.total += bytes;
        let pin = Pin { identity:path.to_owned(),file,version,dependency };
        state.pins.insert(path.to_owned(),pin.clone());
        Ok(pin)
    }
    pub fn write_transfer(&self, destination: &Path) -> anyhow::Result<()> {
        std::fs::create_dir_all(destination)?;
        let (pins,plugins,aliases)={
            let state=self.state.lock();
            anyhow::ensure!(state.frozen,"Only accepted immutable resources can be exported");
            (state.pins.values().cloned().collect::<Vec<_>>(),state.plugins.clone(),state.aliases.clone())
        };
        for pin in &pins {
            std::fs::copy(self.directory.path().join(&pin.file),destination.join(&pin.file))?;
        }
        std::fs::write(destination.join("assets.json"),serde_json::to_vec(&pins)?)?;
        std::fs::write(destination.join("plugins.json"),serde_json::to_vec(&plugins)?)?;
        std::fs::write(destination.join("aliases.json"),serde_json::to_vec(&aliases)?)?;
        Ok(())
    }
    pub fn read_transfer(source: &Path) -> anyhow::Result<Arc<Self>> {
        let file = File::open(source.join("assets.json"))?;
        let pins: Vec<Pin> = serde_json::from_reader(file.take(16 * 1024 * 1024))?;
        let directory = temporary_directory()?;
        let plugins:Vec<PluginPin>=serde_json::from_reader(File::open(source.join("plugins.json"))?.take(16*1024*1024))?;
        for plugin in &plugins {
            let mut input=File::open(&plugin.path).map_err(|e|failure("changed_asset",e.to_string()))?;
            let mut hash=Sha256::new();let mut bytes=0u64;let mut chunk=[0u8;65536];
            loop{let n=input.read(&mut chunk)?;if n==0{break;}bytes+=n as u64;if bytes>plugin.bytes{return Err(failure("changed_asset","Pinned plugin bytes changed").into());}hash.update(&chunk[..n]);}
            if bytes!=plugin.bytes||hex::encode(hash.finalize())!=plugin.version{return Err(failure("changed_asset","Pinned plugin binary changed").into());}
        }
        let aliases:BTreeMap<PathBuf,PathBuf>=serde_json::from_reader(File::open(source.join("aliases.json"))?.take(16*1024*1024))?;
        let mut state = AssetState { pins:BTreeMap::new(),aliases,overlay:BTreeMap::new(),project_overlay:false,plugins,bundles:Vec::new(),total:0,frozen:true };
        for pin in pins {
            anyhow::ensure!(pin.file.starts_with("asset-") && pin.file.bytes().all(|c| c.is_ascii_alphanumeric() || c==b'-'),"Invalid resource cache entry");
            state.total = state.total.checked_add(pin.version.0).ok_or_else(|| anyhow::anyhow!("Resource size overflow"))?;
            anyhow::ensure!(state.total <= ASSET_BUDGET,"Pinned resource budget exceeded");
            let (mut input,mut output) = (File::open(source.join(&pin.file))?,File::create(directory.path().join(&pin.file))?);
            let mut hash = Sha256::new(); let mut length = 0u64; let mut chunk=[0u8;65536];
            loop { let n=input.read(&mut chunk)?; if n==0 {break;} length += n as u64; anyhow::ensure!(length<=pin.version.0,"Changed pinned resource"); hash.update(&chunk[..n]); output.write_all(&chunk[..n])?; }
            anyhow::ensure!(length == pin.version.0 && Some(hex::encode(hash.finalize()).as_str()) == pin.dependency["version"].as_str(),"Changed pinned resource");
            state.pins.insert(pin.identity.clone(),pin);
        }
        Ok(Arc::new(Self { grants:None,directory,state:Mutex::new(state),error:Mutex::new(None),decoded:Arc::new(Default::default()) }))
    }
    pub fn pin_plugins(&self,session:&mut muz::Session)->Result<(),Failure>{
        fn visit(assets:&PinnedAssets,device:&mut muz::model::Device)->Result<(),Failure>{
            if let Some(plugin)=&mut device.vst3 {
                let path=PathBuf::from(&plugin.bundle_env);
                let grants=assets.grants.as_ref().ok_or_else(||failure("missing_plugin","Missing plugin grants"))?;
                grants.plugin(&path)?;
                let path=grants.canonical(&path)?;
                let name=path.file_name().ok_or_else(||failure("missing_plugin","Invalid plugin bundle name"))?;
                fn collect(assets:&PinnedAssets,path:&Path,relative:&Path,files:&mut Vec<(PathBuf,Pin)>,depth:usize)->Result<(),Failure>{
                    if depth>64||files.len()>8192{return Err(failure("resource_budget","Plugin bundle exceeds traversal budget"));}
                    let grants=assets.grants.as_ref().unwrap();
                    let path=grants.canonical(path)?;grants.plugin(&path)?;
                    if path.is_dir(){
                        for entry in std::fs::read_dir(&path).map_err(io_failure)?{
                            let entry=entry.map_err(io_failure)?;
                            collect(assets,&entry.path(),&relative.join(entry.file_name()),files,depth+1)?;
                        }
                    }else{
                        let pin=assets.pin(&path).map_err(|e|core_failure(e,"prepare",&AtomicBool::new(false)))?;
                        files.push((relative.to_owned(),pin));
                    }Ok(())
                }
                let mut files=Vec::new();collect(assets,&path,Path::new(name),&mut files,0)?;
                files.sort_by(|a,b|a.0.cmp(&b.0));
                let mut hash=Sha256::new();hash.update(path.as_os_str().as_encoded_bytes());
                let mut bytes=0u64;
                for (relative,pin) in &files{hash.update(relative.as_os_str().as_encoded_bytes());hash.update([0]);hash.update(pin.dependency["version"].as_str().unwrap().as_bytes());bytes=bytes.saturating_add(pin.version.0);}
                let identity=hex::encode(hash.finalize());
                let bundle={
                    let mut cache=PLUGINS.lock();
                    cache.retain(|_,weak|weak.strong_count()>0);
                    if let Some(bundle)=cache.get(&identity).and_then(Weak::upgrade){bundle}else{
                        let live=cache.values().filter_map(Weak::upgrade).map(|b|b.bytes).sum::<u64>();
                        if bytes>ASSET_BUDGET.saturating_sub(live){return Err(failure("resource_budget","Pinned plugin bundle budget exceeds 512 MiB"));}
                        let directory=temporary_directory().map_err(io_failure)?;
                        let mut pinned=Vec::with_capacity(files.len());
                        for (relative,pin) in files{
                            let destination=directory.path().join(relative);
                            if let Some(parent)=destination.parent(){std::fs::create_dir_all(parent).map_err(io_failure)?;}
                            std::fs::copy(assets.directory.path().join(&pin.file),&destination).map_err(io_failure)?;
                            pinned.push(PluginPin{path:destination,version:pin.dependency["version"].as_str().unwrap().to_owned(),bytes:pin.version.0});
                        }
                        let root=directory.path().join(name);
                        let bundle=Arc::new(PluginBundle{_directory:directory,root,files:pinned,bytes});
                        cache.insert(identity,Arc::downgrade(&bundle));bundle
                    }
                };
                plugin.bundle_env=bundle.root.to_string_lossy().into_owned();
                let mut state=assets.state.lock();
                if !state.bundles.iter().any(|b|Arc::ptr_eq(b,&bundle)){
                    state.plugins.extend(bundle.files.iter().cloned());state.bundles.push(bundle);
                }
            }
            if let Some(rack)=&mut device.rack{for child in rack.branches.iter_mut().flatten(){visit(assets,child)?;}}
            Ok(())
        }
        for device in session.tracks.iter_mut().flat_map(|t|std::iter::once(&mut t.instrument).chain(t.inserts.iter_mut()))
            .chain(session.buses.iter_mut().flat_map(|b|b.inserts.iter_mut())).chain(session.master.inserts.iter_mut()){visit(self,device)?;}
        Ok(())
    }
}
fn text_asset(path:&Path)->bool{
    path.extension().and_then(|s|s.to_str()).is_some_and(|extension|
        ["muz","sfz","json","json5","txt","toml","md"].iter().any(|kind|extension.eq_ignore_ascii_case(kind)))
}
impl AssetResolver for PinnedAssets {
    fn resolve(&self, path:&Path)->anyhow::Result<PathBuf> {
        let path = lexical(path)?;
        {
            let state=self.state.lock();
            if state.pins.contains_key(&path)||state.overlay.contains_key(&path){return Ok(path);}
            if let Some(identity)=state.aliases.get(&path){return Ok(identity.clone());}
            if state.frozen{return Err(failure("changed_asset",format!("Uncaptured resource {}",path.display())).into());}
            if state.project_overlay&&self.grants.as_ref().is_some_and(|g|path.starts_with(&g.project_root))
                &&text_asset(&path){
                let failure=path_failure("missing_sample",&path,"Text asset is absent or deleted in the source snapshot");
                *self.error.lock()=Some(failure.clone());return Err(failure.into());
            }
        }
        if path==muz::plugins::config_path() && !path.exists(){return Err(std::io::Error::new(std::io::ErrorKind::NotFound,"Plugin alias file is not configured").into());}
        let resolved=remember(self.grants.as_ref().unwrap().canonical(&path).map_err(|mut e|{if e.code=="missing_module"{e.code="missing_sample".into();}e}),&self.error)?;
        self.state.lock().aliases.insert(path,resolved.clone());
        Ok(resolved)
    }
    fn resolve_case_insensitive(&self,path:&Path)->anyhow::Result<PathBuf> {
        if let Ok(path)=self.resolve(path) {return Ok(path);}
        let lexical=lexical(path)?;
        let overlay_match={
            let state=self.state.lock();
            let mut matches=state.overlay.keys().filter(|p|p.as_os_str().as_encoded_bytes().eq_ignore_ascii_case(lexical.as_os_str().as_encoded_bytes()));
            let found=matches.next().cloned();
            anyhow::ensure!(matches.next().is_none(),"Ambiguous captured SFZ path case");found
        };
        if let Some(resolved)=overlay_match{
            self.error.lock().take();self.state.lock().aliases.insert(lexical,resolved.clone());return Ok(resolved);
        }
        if self.state.lock().project_overlay&&self.grants.as_ref().is_some_and(|g|lexical.starts_with(&g.project_root))&&text_asset(&lexical){
            return self.resolve(path);
        }
        if self.state.lock().frozen { return self.resolve(path); }
        let grants=self.grants.as_ref().unwrap();
        let roots=grants.entries.iter().map(|g|g.path.clone());
        let resolver=muz::assets::ScopedFileAssets::new(roots)?;
        let resolved=resolver.resolve_case_insensitive(path)?;
        let resolved=remember(grants.canonical(&resolved),&self.error)?;
        self.error.lock().take();self.state.lock().aliases.insert(lexical,resolved.clone());
        Ok(resolved)
    }
    fn version(&self,path:&Path)->anyhow::Result<(u64,u128)> { Ok(self.pin(path)?.version) }
    fn open(&self,path:&Path)->anyhow::Result<Box<dyn AssetReader>> { let pin=self.pin(path)?; Ok(Box::new(File::open(self.directory.path().join(pin.file))?)) }
    fn snapshot(&self,path:&Path,max:usize)->anyhow::Result<AssetSnapshot> {
        let pin=self.pin(path)?;
        anyhow::ensure!(pin.version.0<=max as u64,"Resource byte limit exceeded");
        Ok(AssetSnapshot { version:pin.version,bytes:std::fs::read(self.directory.path().join(pin.file))?.into() })
    }
}
pub fn context(assets: Arc<PinnedAssets>, cancelled: Arc<AtomicBool>) -> muz::host::HostContext {
    muz::host::HostContext { provenance:true,decoded_assets:assets.decoded.clone(),assets,cancelled,..Default::default() }
}

struct UploadFile { path:PathBuf, bytes:usize, content:Vec<u8>, next:u64 }
pub struct Upload { descriptor:Value, files:BTreeMap<String,UploadFile>, grants:Arc<Grants>, total:usize }
pub struct Snapshot { pub descriptor:Value, pub entry:PathBuf, grants:Arc<Grants>, overlay:BTreeMap<PathBuf,Arc<str>>, imported:Mutex<BTreeMap<PathBuf,(Arc<str>,Value)>>, error:Mutex<Option<Failure>>, bytes:usize }
impl Upload {
    pub fn begin(args:&Value,grants:Arc<Grants>)->Result<Self,Failure> {
        let descriptor=args["snapshot"].clone();
        if descriptor["id"].as_str().is_none() {return Err(failure("invalid_source","Missing snapshot identity"));}
        let mut files=BTreeMap::new(); let mut total=0usize;
        for file in args["files"].as_array().ok_or_else(||failure("invalid_source","Missing snapshot files"))? {
            let id=file["fileId"].as_str().ok_or_else(||failure("invalid_source","Missing file identity"))?;
            let path=file["path"].as_str().ok_or_else(||failure("invalid_source","Missing file path"))?;
            let path=lexical(&grants.project_root.join(path))?;
            grants.locate(&path)?;
            let bytes=file["bytes"].as_u64().filter(|n|*n<=SOURCE_DOCUMENT_BYTES as u64).ok_or_else(||failure("too_large","Source document size invalid"))? as usize;
            total=total.checked_add(bytes).ok_or_else(||failure("too_large","Snapshot overflow"))?;
            if total>SOURCE_SNAPSHOT_BYTES {return Err(failure("too_large","Source snapshot budget exceeded"));}
            if files.insert(id.to_owned(),UploadFile {path,bytes,content:Vec::with_capacity(bytes),next:0}).is_some() {return Err(failure("invalid_source","Duplicate source identity"));}
        }
        Ok(Self { descriptor,files,grants,total })
    }
    pub fn chunk(&mut self,args:&Value)->Result<(),Failure> {
        let file=self.files.get_mut(args["fileId"].as_str().unwrap_or("")).ok_or_else(||failure("invalid_source","Unknown snapshot file"))?;
        if args["index"].as_u64()!=Some(file.next) {return Err(failure("invalid_source","Out of order source chunk"));}
        let data=args["data"].as_str().ok_or_else(||failure("invalid_source","Missing source data"))?;
        if data.len()>CHUNK_BYTES.div_ceil(3)*4 {return Err(failure("too_large","Source chunk too large"));}
        let data=base64::engine::general_purpose::STANDARD.decode(data).map_err(|e|failure("invalid_source",e.to_string()))?;
        if data.len()>CHUNK_BYTES || data.len()>file.bytes.saturating_sub(file.content.len()) {return Err(failure("too_large","Source upload exceeds declared bytes"));}
        file.content.extend(data);file.next+=1;Ok(())
    }
    pub fn finish(self)->Result<Arc<Snapshot>,Failure> {
        let mut overlay=BTreeMap::new();
        for (_,file) in self.files {
            if file.content.len()!=file.bytes {return Err(failure("invalid_source","Incomplete source upload"));}
            let text=String::from_utf8(file.content).map_err(|e|failure("invalid_source",e.to_string()))?;
            if overlay.insert(file.path,Arc::from(text)).is_some() {return Err(failure("invalid_source","Duplicate source path"));}
        }
        let entry=self.descriptor["entry"].as_str().ok_or_else(||failure("invalid_source","Missing snapshot entry"))?;
        let entry=lexical(&self.grants.project_root.join(entry))?;
        Ok(Arc::new(Snapshot {descriptor:self.descriptor,entry,grants:self.grants,overlay,imported:Mutex::new(BTreeMap::new()),error:Mutex::new(None),bytes:self.total}))
    }
}
impl Snapshot {
    pub fn loader(self:&Arc<Self>) -> std::rc::Rc<dyn muz::lang::SourceLoader> {std::rc::Rc::new(Overlay(self.clone()))}
    pub fn assets(&self)->Result<Arc<PinnedAssets>,Failure> {
        let assets=PinnedAssets::new(self.grants.clone())?;
        {let mut state=assets.state.lock();state.overlay=self.overlay.clone();state.project_overlay=true;}
        Ok(assets)
    }
    pub fn path(&self,entry:&str)->Result<PathBuf,Failure> {lexical(&self.grants.project_root.join(entry))}
    pub fn same_capture(&self,other:&Self)->bool{self.descriptor==other.descriptor&&self.overlay==other.overlay&&self.entry==other.entry}
    pub fn dependencies(&self)->Vec<Value> {self.imported.lock().values().map(|(_,d)|d.clone()).collect()}
    pub fn pin_plugins(&self,session:&mut muz::Session,assets:&PinnedAssets)->Result<(),Failure>{assets.pin_plugins(session)}
}
struct Overlay(Arc<Snapshot>);
impl muz::lang::SourceLoader for Overlay {
    fn resolve(&self,path:&Path)->anyhow::Result<PathBuf> {
        let path=lexical(path)?;
        if self.0.overlay.contains_key(&path) {return Ok(path);}
        if path.starts_with(&self.0.grants.project_root) {
            return Ok(remember(Err(path_failure("missing_module",&path,format!("Module is absent or deleted in captured sources: {}",path.display()))),&self.0.error)?);
        }
        Ok(remember(self.0.grants.canonical(&path),&self.0.error)?)
    }
    fn read(&self,path:&Path)->anyhow::Result<String> {
        muz::host::check_cancelled()?;
        if let Some(text)=self.0.overlay.get(path) {
            if !path.starts_with(&self.0.grants.project_root){
                let (index,relative)=self.0.grants.locate(path)?;
                let dependency=json!({"grant":self.0.grants.entries[index].id,"path":relative.to_string_lossy(),"version":hex::encode(Sha256::digest(text.as_bytes()))});
                self.0.imported.lock().entry(path.to_owned()).or_insert_with(||(text.clone(),dependency));
            }
            return Ok(text.to_string());
        }
        let mut imported=self.0.imported.lock();
        if let Some((text,_))=imported.get(path) {return Ok(text.to_string());}
        let used=self.0.bytes+imported.values().map(|(s,_)|s.len()).sum::<usize>();
        let (bytes,dependency,_)=remember(read_stable(&self.0.grants,path,SOURCE_DOCUMENT_BYTES.min(SOURCE_SNAPSHOT_BYTES.saturating_sub(used))),&self.0.error)?;
        let text=String::from_utf8(bytes).map_err(|e|failure("invalid_source",e.to_string()))?;
        imported.insert(path.to_owned(),(Arc::from(text.as_str()),dependency));Ok(text)
    }
    fn contrib_root(&self)->anyhow::Result<PathBuf> {Ok(remember(self.0.grants.contrib(),&self.0.error)?)}
}

pub fn compile(snapshot:&Arc<Snapshot>,entry:&Path,cancel:Arc<AtomicBool>)->Result<(muz::compile::Compiled,Arc<PinnedAssets>),Failure> {
    let assets=snapshot.assets()?;
    snapshot.error.lock().take();
    let context=context(assets.clone(),cancel.clone());
    let mut compiled=muz::compile::compile_with_context(entry,snapshot.loader(),&context)
        .map_err(|e|{
            let mut failure=core_failure(e,"compile",&cancel);
            if let Some(resource)=snapshot.error.lock().take().or_else(||assets.error.lock().take()){failure.code=resource.code;failure.path=resource.path;}
            failure
        })?;
    context.run(||snapshot.pin_plugins(&mut compiled.session,&assets))?;
    Ok((compiled,assets))
}
pub fn core_failure(error:anyhow::Error,phase:&str,cancel:&AtomicBool)->Failure {
    if let Some(failure)=error.downcast_ref::<Failure>() {let mut f=failure.clone(); f.phase=phase.into();return f;}
    let diagnostic=error.chain().find_map(|cause|cause.downcast_ref::<muz::lang::Diagnostic>());
    let message=if diagnostic.is_some(){String::new()}else{error.to_string()};
    diagnostic_failure(Failure::new(if cancel.load(Ordering::Relaxed){"cancelled"}else{"invalid_source"},phase,message),diagnostic)
}
pub fn diagnostic_failure(mut failure:Failure,diagnostic:Option<&muz::lang::Diagnostic>)->Failure {
    if let Some(diagnostic)=diagnostic {
        let mut value=diagnostic.to_json();
        failure.message=serde_json::from_value(value["message"].take()).unwrap_or(failure.message);
        failure.location=Some(value["location"].take()).filter(|v|!v.is_null());
        failure.callers=value.get_mut("callers").map(Value::take);
        failure.help=serde_json::from_value(value["help"].take()).ok();
        failure.path=serde_json::from_value(value["path"].take()).unwrap_or(None);
    }
    if serde_json::to_vec(&failure).is_ok_and(|bytes|bytes.len()>128*1024){
        return Failure::new("too_large",failure.phase,"Structured diagnostic exceeds the bounded response budget");
    }
    failure
}

#[cfg(all(test,target_os="linux"))]
mod tests {
    use super::*;
    fn grants(root:&Path)->Arc<Grants>{
        Grants::new(json!([{"id":"project:test","kind":"project","path":root}])).unwrap()
    }
    fn snapshot(root:&Path,path:&str,text:&str)->Arc<Snapshot>{
        let mut upload=Upload::begin(&json!({
            "snapshot":{"id":"snapshot","project":"project","epoch":"epoch","sourceVersion":1,"entry":path},
            "entry":path,"files":[{"fileId":"file","path":path,"bytes":text.len(),"diskVersion":null}]
        }),grants(root)).unwrap();
        upload.chunk(&json!({"fileId":"file","index":0,"data":base64::engine::general_purpose::STANDARD.encode(text)})).unwrap();
        upload.finish().unwrap()
    }
    #[test]
    fn semantic_automation_failure_preserves_structured_source_context(){
        let directory=tempfile::tempdir().unwrap();let root=directory.path().canonicalize().unwrap();
        let source="// Ω source\nsong({title:\"Ω 𝄞\",tracks:[track(\"lead\",phrase(\"C4:q\"),synth(\"bell\"))],automation:[automation(\"lead.missing.cutoff_hz\",curve([[0b,200],[1b,8000]]))]});";
        let snapshot=snapshot(&root,"main.muz",source);
        let (compiled,assets)=compile(&snapshot,&snapshot.entry,Arc::new(AtomicBool::new(false))).unwrap();
        let error=match context(assets,Arc::new(AtomicBool::new(false))).run(||muz::audio::AudioEngine::new(
            &compiled.session,muz::audio::AudioConfig{sample_rate:48_000.0,max_frames:256,offline:true},
        )){
            Ok(_)=>panic!("unknown automation target unexpectedly prepared"),Err(error)=>error,
        };
        let failure=core_failure(error.into(),"prepare",&AtomicBool::new(false));
        assert_eq!(failure.message,"automation target 'lead.missing.cutoff_hz' is unknown");
        let location=failure.location.as_ref().expect("semantic error keeps a structured location");
        assert_eq!(location["path"],root.join("main.muz").to_string_lossy().as_ref());
        let line=source.lines().nth(1).unwrap();
        let start=line.find("automation(").unwrap();
        assert_eq!(location["line"],2);
        assert_eq!(location["column"],line[..start].chars().count()+1);
        assert_eq!(location["text"],line);
        assert!(failure.help.as_ref().is_some_and(|help|help.iter().any(|line|line.contains("targets under 'lead'"))));
        assert_eq!(failure.phase,"prepare");assert_eq!(failure.code,"invalid_source");
    }
    #[test]
    fn exact_plugin_and_config_grants_never_authorize_siblings(){
        let project=tempfile::tempdir().unwrap();let installation=tempfile::tempdir().unwrap();
        let project=project.path().canonicalize().unwrap();let root=installation.path().canonicalize().unwrap();
        for name in ["Surge.clap","other.clap","plugins.json","secret.json"] {
            std::fs::write(root.join(name),name).unwrap();
        }
        let grants=Grants::new(json!([
            {"id":"project","kind":"project","path":project},
            {"id":"surge","kind":"plugin","path":root,"exact":"Surge.clap"},
            {"id":"config","kind":"config","path":root,"exact":"plugins.json"}
        ])).unwrap();
        grants.plugin(&root.join("Surge.clap")).unwrap();
        let (_,dependency)=grants.open(&root.join("Surge.clap")).unwrap();
        assert_eq!(dependency,json!({"grant":"surge","path":"Surge.clap"}));
        grants.open(&root.join("plugins.json")).unwrap();
        assert_eq!(grants.open(&root.join("other.clap")).unwrap_err().code,"grant_required");
        assert_eq!(grants.open(&root.join("secret.json")).unwrap_err().code,"grant_required");
        assert!(grants.plugin(&root.join("plugins.json")).is_err());
        for exact in ["../Surge.clap","sub/Surge.clap","/Surge.clap"] {
            assert!(Grants::new(json!([
                {"id":"project","kind":"project","path":project},
                {"id":"surge","kind":"plugin","path":root,"exact":exact}
            ])).is_err());
        }
        let source=format!("use {} as leaked; song({{tracks:[]}})",serde_json::to_string(&root.join("secret.json")).unwrap());
        let mut upload=Upload::begin(&json!({
            "snapshot":{"id":"restricted","entry":"main.muz"},
            "files":[{"fileId":"main","path":"main.muz","bytes":source.len()}]
        }),grants).unwrap();
        upload.chunk(&json!({"fileId":"main","index":0,"data":base64::engine::general_purpose::STANDARD.encode(&source)})).unwrap();
        let snapshot=upload.finish().unwrap();
        // Entry checking and rebuilding share this compilation path, before apply gating.
        let failure=match compile(&snapshot,&snapshot.entry,Arc::new(AtomicBool::new(false))) {
            Ok(_)=>panic!("Exact grant permitted a sibling import"),
            Err(failure)=>failure,
        };
        assert_eq!(failure.code,"grant_required");
        assert!(snapshot.dependencies().is_empty());
    }
    #[test]
    fn source_overlay_never_falls_back_to_deleted_disk_source(){
        let directory=tempfile::tempdir().unwrap();let root=directory.path().canonicalize().unwrap();
        std::fs::write(root.join("deleted.muz"),"old disk").unwrap();
        let captured=snapshot(&root,"main.muz","dirty editor");
        let loader=captured.loader();
        assert_eq!(loader.read(&root.join("main.muz")).unwrap(),"dirty editor");
        assert!(loader.resolve(&root.join("deleted.muz")).is_err());
        assert!(captured.same_capture(&snapshot(&root,"main.muz","dirty editor")));
        assert!(!captured.same_capture(&snapshot(&root,"main.muz","new editor")));
    }
    #[test]
    fn dirty_text_assets_and_export_transfer_are_immutable(){
        let directory=tempfile::tempdir().unwrap();let root=directory.path().canonicalize().unwrap();
        std::fs::write(root.join("instrument.sfz"),"disk version").unwrap();
        let captured=snapshot(&root,"instrument.sfz","edited instrument");
        let assets=captured.assets().unwrap();let identity=assets.resolve(&root.join("instrument.sfz")).unwrap();
        let first=assets.snapshot(&identity,1024).unwrap();assets.freeze();
        std::fs::write(&identity,"changed after acceptance").unwrap();
        assert_eq!(&*assets.snapshot(&identity,1024).unwrap().bytes,b"edited instrument");
        let transfer=tempfile::tempdir().unwrap();assets.write_transfer(transfer.path()).unwrap();
        let restored=PinnedAssets::read_transfer(transfer.path()).unwrap();
        let copy=restored.snapshot(&identity,1024).unwrap();
        assert_eq!(copy.version,first.version);assert_eq!(copy.bytes,first.bytes);
        assert!(restored.resolve(&root.join("uncaptured.wav")).is_err());
    }
    #[test]
    fn binary_pins_survive_original_deletion(){
        let directory=tempfile::tempdir().unwrap();let root=directory.path().canonicalize().unwrap();
        let path=root.join("sample.wav");std::fs::write(&path,b"original bytes").unwrap();
        let assets=PinnedAssets::new(grants(&root)).unwrap();
        let identity=assets.resolve(&path).unwrap();let first=assets.snapshot(&identity,1024).unwrap();
        assets.freeze();std::fs::remove_file(&path).unwrap();
        assert_eq!(assets.resolve(&path).unwrap(),identity);
        assert_eq!(assets.snapshot(&identity,1024).unwrap().bytes,first.bytes);
    }
    #[test]
    fn source_chunks_are_ordered_and_exact(){
        let directory=tempfile::tempdir().unwrap();let root=directory.path().canonicalize().unwrap();
        let mut upload=Upload::begin(&json!({"snapshot":{"id":"s","entry":"main.muz"},"files":[{"fileId":"f","path":"main.muz","bytes":3}]}),grants(&root)).unwrap();
        assert!(upload.chunk(&json!({"fileId":"f","index":1,"data":"YWJj"})).is_err());
        assert!(upload.chunk(&json!({"fileId":"f","index":0,"data":"YWJjZA=="})).is_err());
        assert!(upload.finish().is_err());
    }
    #[test]
    fn granted_directory_descriptor_rejects_symlink_escape(){
        use std::os::unix::fs::symlink;
        let inside=tempfile::tempdir().unwrap();let outside=tempfile::tempdir().unwrap();
        let root=inside.path().canonicalize().unwrap();let secret=outside.path().join("secret.wav");
        std::fs::write(&secret,b"secret").unwrap();symlink(&secret,root.join("escape.wav")).unwrap();
        let grants=grants(&root);
        assert!(grants.open(&root.join("escape.wav")).is_err());
        let failure=grants.canonical(&root.join("escape.wav")).unwrap_err();
        assert_eq!(failure.code,"grant_required");assert_eq!(failure.path.as_deref(),secret.to_str());
    }
}
