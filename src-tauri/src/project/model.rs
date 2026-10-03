use crate::protocol::{Failure, SOURCE_DOCUMENT_BYTES, SOURCE_SNAPSHOT_BYTES};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, sync::Arc};
use super::secure_fs::Root;
use crate::protocol::validate_path;

pub const SETTINGS: &str = "muzpad.json";
pub const MAX_FILES: usize = 8192;
pub const MAX_ASSETS: u64 = 256 * 1024 * 1024;
pub const MAX_SAFE: u64 = 9_007_199_254_740_991;
pub fn failure(code: &str, message: impl Into<String>) -> Failure { Failure::new(code, "project", message) }
pub fn opaque() -> String { uuid::Uuid::new_v4().to_string() }
pub fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, Failure> {
    serde_json::from_value(value).map_err(|e| failure("invalid_source", e.to_string()))
}
pub fn text_kind(path: &str) -> Option<&'static str> {
    let extension = path.rsplit('.').next()?.to_ascii_lowercase();
    match extension.as_str() {
        "muz" => Some("source"), "md" | "markdown" => Some("document"),
        "txt" | "json" | "json5" | "sfz" | "toml" => Some("text"), _ => None,
    }
}
pub fn resource_kind(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "mid" | "midi" => "midi", "wav" => "wav", "flac" => "flac",
        "clap" | "vst3" => "plugin", _ => "sample",
    }
}
pub fn digest(bytes: &[u8]) -> String { use sha2::Digest; hex::encode(sha2::Sha256::digest(bytes)) }
pub fn stable_file_id(project: &str, path: &str) -> String { digest(format!("{project}\0{path}").as_bytes()) }
pub fn validate_gist(gist: &str) -> Result<(), Failure> {
    let (id, revision) = gist.split_once('/').map_or((gist, None), |(id, revision)| (id, Some(revision)));
    let lower_hex = |value: &str| value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !(32..=40).contains(&id.len()) || !lower_hex(id) || revision.is_some_and(|value| value.len() != 40 || !lower_hex(value)) {
        return Err(failure("invalid_source", "Gist origin must be a lowercase hexadecimal ID with an optional full revision"));
    }
    Ok(())
}
pub fn deserialize_gist<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let gist = String::deserialize(deserializer)?;
    validate_gist(&gist).map_err(|error| serde::de::Error::custom(error.message))?;
    Ok(Some(gist))
}
pub fn with_gist(mut value: Value, gist: Option<&str>) -> Value {
    if let Some(gist) = gist { value["gist"] = json!(gist); }
    value
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings { pub title: String, pub entry: String, #[serde(default, skip_serializing_if = "Option::is_none")] pub entries: Option<Vec<String>> }
// Omitted entries mean the selected entry, exactly as exposed by ProjectSnapshot.
// Round-tripping that snapshot must not invent a source/settings edit.
impl PartialEq for Settings {
    fn eq(&self, other: &Self) -> bool {
        self.title == other.title && self.entry == other.entry
            && self.entries.as_deref().unwrap_or(std::slice::from_ref(&self.entry))
                == other.entries.as_deref().unwrap_or(std::slice::from_ref(&other.entry))
    }
}
impl Eq for Settings {}
impl Settings {
    pub fn validate(&self) -> Result<(), Failure> {
        if self.title.len() > 4096 || self.title.contains('\0') { return Err(failure("invalid_source", "Invalid project title")); }
        validate_path(&self.entry)?;
        if let Some(entries) = &self.entries {
            if entries.len() > MAX_FILES { return Err(failure("resource_budget", "Too many entries")); }
            let mut unique = BTreeSet::new();
            for entry in entries { validate_path(entry)?; if !unique.insert(entry) { return Err(failure("invalid_source", "Duplicate entry")); } }
        }
        Ok(())
    }
    pub fn bytes(&self) -> Result<Vec<u8>, Failure> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| failure("invalid_source", e.to_string()))?;
        if bytes.len() > SOURCE_DOCUMENT_BYTES { return Err(failure("too_large","Project settings exceed 8 MiB")); }
        Ok(bytes)
    }
    pub fn entries(&self) -> Vec<String> { self.entries.clone().unwrap_or_else(|| vec![self.entry.clone()]) }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capture { pub file_id: String, pub path: String, pub text: Option<String>, pub buffer_version: u64, pub expected_disk_version: Option<String> }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkingCapture {
    pub project: String, pub epoch: String, pub source_version: u64, pub entry: String,
    pub expected_disk_generation: String, pub buffers: Vec<Capture>, pub settings: Settings,
    pub settings_disk_version: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveInput { pub project: String, pub epoch: String, pub files: Vec<Capture>, pub settings: Settings, pub settings_disk_version: Option<String> }
#[derive(Clone, Debug)]
pub struct Buffer {
    pub id: String, pub path: String, pub text: Option<String>, pub version: u64,
    pub base: Option<String>, pub disk_version: Option<String>, pub conflict: Option<Value>,
    pub history: Vec<(Option<String>, Option<String>)>,
}
impl Buffer {
    pub fn dirty(&self) -> bool { self.text != self.base }
    pub fn capture(&self) -> Capture { Capture { file_id:self.id.clone(),path:self.path.clone(),text:self.text.clone(),buffer_version:self.version,expected_disk_version:self.disk_version.clone() } }
    pub fn dto(&self) -> Value { json!({"id":self.id,"path":self.path,"kind":text_kind(&self.path).unwrap_or("text"),"readOnly":false,"bufferVersion":self.version,"diskVersion":self.disk_version,"text":self.text.as_deref().unwrap_or(""),"dirty":self.dirty(),"deleted":self.text.is_none()}) }
    pub fn conflict_with(&self, disk: Option<&str>, disk_version: Option<&str>) -> Value {
        json!({"fileId":self.id,"path":self.path,"base":self.base,"local":self.text,"disk":disk,"baseVersion":self.disk_version,"diskVersion":disk_version,"bufferVersion":self.version})
    }
}
pub struct Workspace {
    pub project: String, pub epoch: String, pub root: Arc<Root>, pub persisted: bool,
    pub gist: Option<String>,
    pub trusted: bool,
    pub settings: Settings, pub settings_base: Option<String>, pub settings_version: Option<String>,
    pub settings_conflict: Option<Value>, pub source_version: u64, pub disk_generation: u64,
    pub files: BTreeMap<String, Buffer>, pub resources: Vec<Value>,
    pub asset_origin: Option<Arc<Root>>,
    pub acknowledged_source: u64,
    pub settings_history: Vec<(Option<String>, Option<String>)>,
    pub recent_saves: BTreeMap<(String, Option<String>, Option<String>), u64>,
}
impl Workspace {
    pub fn project_ref(&self) -> Value { json!({"project":self.project,"epoch":self.epoch}) }
    pub fn root_label(&self) -> Option<String> { self.persisted.then(|| self.root.path().to_string_lossy().into_owned()) }
    pub fn settings_dirty(&self) -> bool { self.settings_base.as_ref().and_then(|s| serde_json::from_str::<Settings>(s).ok()).as_ref() != Some(&self.settings) }
    pub fn dirty(&self) -> bool { self.settings_dirty() || self.files.values().any(Buffer::dirty) || self.resources.iter().any(|r| r["pendingSave"] == true) }
    pub fn conflicts(&self) -> Vec<Value> { self.files.values().filter_map(|f| f.conflict.clone()).chain(self.settings_conflict.clone()).collect() }
    pub fn snapshot(&self) -> Value { with_gist(json!({"project":self.project,"epoch":self.epoch,"title":self.settings.title,"entry":self.settings.entry,"entries":self.settings.entries(),"sourceVersion":self.source_version,"diskGeneration":self.disk_generation.to_string(),"settingsDiskVersion":self.settings_version,"files":self.files.values().map(Buffer::dto).collect::<Vec<_>>(),"resources":self.resources.iter().map(public_resource).collect::<Vec<_>>(),"conflicts":self.conflicts(),"dirty":self.dirty(),"rootLabel":self.root_label(),"execution":{"trusted":self.trusted,"policy":if self.trusted{"account-native"}else{"preview"}}}), self.gist.as_deref()) }
    pub fn working_capture(&self) -> WorkingCapture { WorkingCapture { project:self.project.clone(),epoch:self.epoch.clone(),source_version:self.source_version,entry:self.settings.entry.clone(),expected_disk_generation:self.disk_generation.to_string(),buffers:self.files.values().map(Buffer::capture).collect(),settings:self.settings.clone(),settings_disk_version:self.settings_version.clone() } }
    pub fn assert_ref(&self, project: &str, epoch: &str) -> Result<(), Failure> { if self.project != project || self.epoch != epoch { Err(failure("stale_request", "Project identity has expired")) } else { Ok(()) } }
    pub fn acknowledge(&mut self, capture: &WorkingCapture) -> Result<(), Failure> {
        self.assert_ref(&capture.project, &capture.epoch)?;
        capture.settings.validate()?;
        if capture.source_version > MAX_SAFE || capture.source_version < self.acknowledged_source { return Err(failure("stale_request", "A newer editor capture is already acknowledged")); }
        let generation = capture.expected_disk_generation.parse::<u64>().map_err(|_| failure("invalid_source","Invalid disk generation"))?;
        if generation > self.disk_generation || generation.to_string() != capture.expected_disk_generation || capture.entry != capture.settings.entry { return Err(failure("stale_request","Invalid capture generation or entry")); }
        if capture.buffers.len() > MAX_FILES { return Err(failure("resource_budget","Too many source documents")); }
        let settings_stale = capture.settings_disk_version != self.settings_version;
        let settings_base = if settings_stale { self.settings_history.iter().rev().find(|(version,_)| version == &capture.settings_disk_version).and_then(|(_,text)| text.clone()) } else { self.settings_base.clone() };
        let unchanged_old_settings = settings_stale && (capture.settings == self.settings || settings_base.as_ref().and_then(|text|serde_json::from_str::<Settings>(text).ok()).as_ref() == Some(&capture.settings));
        let settings_changed = !unchanged_old_settings && capture.settings != self.settings;
        let settings_text = if settings_changed || self.settings_conflict.is_some() { Some(String::from_utf8(capture.settings.bytes()?).map_err(|_|failure("invalid_source","Settings encoding failed"))?) } else { None };
        let mut ids = BTreeSet::new(); let mut paths = BTreeSet::new(); let mut total = 0usize;
        let mut changed = settings_changed;
        for item in &capture.buffers {
            validate_path(&item.path)?;
            if item.path == SETTINGS || text_kind(&item.path).is_none() || item.file_id.is_empty() || item.file_id.len() > 256 || item.buffer_version > MAX_SAFE || !ids.insert(item.file_id.clone()) || !paths.insert(item.path.clone()) { return Err(failure("invalid_source","Invalid or duplicate source identity")); }
            let bytes = item.text.as_ref().map_or(0,String::len);
            total = total.checked_add(bytes).ok_or_else(||failure("too_large","Capture size overflow"))?;
            if bytes > SOURCE_DOCUMENT_BYTES || total > SOURCE_SNAPSHOT_BYTES { return Err(failure("too_large","Source capture exceeds the host budget")); }
            match self.files.get(&item.file_id) {
                Some(old) => {
                    if old.path != item.path { return Err(failure("denied_path","A source identity cannot change its path")); }
                    let own_save = self.recent_saves.get(&(item.file_id.clone(),item.expected_disk_version.clone(),old.disk_version.clone())).is_some_and(|saved|item.buffer_version > *saved);
                    if old.disk_version != item.expected_disk_version && !own_save {
                        let base = old.history.iter().rev().find(|(version,_)|version == &item.expected_disk_version).and_then(|(_,text)|text.clone());
                        changed |= item.text != base && (old.dirty() || item.text != old.text);
                    } else {
                        if item.buffer_version < old.version || (item.buffer_version == old.version && item.text != old.text) { return Err(failure("stale_request",format!("Newer buffer already acknowledged: {}",item.path))); }
                        changed |= item.text != old.text || item.buffer_version != old.version;
                    }
                }
                None => {
                    if item.expected_disk_version.is_some() || self.files.values().any(|file|file.path == item.path && file.dirty()) || self.resources.iter().any(|resource|resource["path"] == item.path) { return Err(failure("source_conflict","New source does not have a missing baseline")); }
                    changed = true;
                }
            }
        }
        if self.files.iter().any(|(id,file)| !ids.contains(id) && !paths.contains(&file.path) && (generation == self.disk_generation || file.dirty())) { return Err(failure("invalid_source","Capture must include closed buffers and explicit deletions")); }
        for (id,file) in &self.files { if !ids.contains(id) && !paths.contains(&file.path) { total = total.checked_add(file.text.as_ref().map_or(0,String::len)).ok_or_else(||failure("too_large","Capture size overflow"))?; } }
        if total > SOURCE_SNAPSHOT_BYTES { return Err(failure("too_large","Reconciled source capture exceeds 64 MiB")); }
        if changed && capture.source_version <= self.acknowledged_source { return Err(failure("stale_request","Changed editor buffers must advance sourceVersion")); }
        let next_source = if changed { self.source_version.checked_add(1).filter(|version|*version <= MAX_SAFE).ok_or_else(||failure("resource_budget","Source version exhausted"))?.max(capture.source_version) } else { self.source_version.max(capture.source_version) };
        for item in &capture.buffers {
            match self.files.get_mut(&item.file_id) {
                Some(file) => {
                    let own_save = self.recent_saves.get(&(item.file_id.clone(),item.expected_disk_version.clone(),file.disk_version.clone())).is_some_and(|saved|item.buffer_version > *saved);
                    if file.disk_version != item.expected_disk_version && !own_save {
                        let base = file.history.iter().rev().find(|(version,_)|version == &item.expected_disk_version).and_then(|(_,text)|text.clone());
                        if item.text == base || (!file.dirty() && item.text == file.text) { continue; }
                        file.conflict = Some(json!({"fileId":file.id,"path":file.path,"base":base,"local":item.text,"disk":file.base,"baseVersion":item.expected_disk_version,"diskVersion":file.disk_version,"bufferVersion":item.buffer_version}));
                        file.base = base; file.disk_version = item.expected_disk_version.clone();
                    }
                    file.text = item.text.clone(); file.version = item.buffer_version;
                    if let Some(conflict) = file.conflict.as_mut() { conflict["local"] = json!(file.text); conflict["bufferVersion"] = json!(file.version); }
                }
                None => {
                    let collision = self.files.values().find(|file|file.path == item.path).map(|file|file.id.clone()).and_then(|id|self.files.remove(&id));
                    let conflict = collision.map(|disk|json!({"fileId":item.file_id,"path":item.path,"base":null,"local":item.text,"disk":disk.base,"baseVersion":null,"diskVersion":disk.disk_version,"bufferVersion":item.buffer_version}));
                    self.files.insert(item.file_id.clone(),Buffer { id:item.file_id.clone(),path:item.path.clone(),text:item.text.clone(),version:item.buffer_version,base:None,disk_version:None,conflict,history:Vec::new() });
                }
            }
        }
        if !unchanged_old_settings {
            if settings_stale {
                self.settings_conflict = Some(json!({"fileId":"settings","path":SETTINGS,"base":settings_base,"local":settings_text,"disk":self.settings_base,"baseVersion":capture.settings_disk_version,"diskVersion":self.settings_version,"bufferVersion":capture.source_version}));
                self.settings_base = settings_base; self.settings_version = capture.settings_disk_version.clone();
            }
            self.settings = capture.settings.clone();
            if let Some(conflict) = self.settings_conflict.as_mut() { conflict["local"] = json!(settings_text); conflict["bufferVersion"] = json!(capture.source_version); }
        }
        self.acknowledged_source = capture.source_version; self.source_version = next_source;
        Ok(())
    }
}
pub fn public_resource(resource: &Value) -> Value { let mut value = resource.clone(); if let Some(object) = value.as_object_mut() { object.remove("pendingSave"); } value }
pub fn resource(project: &str, path: &str, bytes: u64, version: Option<String>, linked: bool) -> Value {
    json!({"id":stable_file_id(project,path),"path":path,"kind":resource_kind(path),"version":version,"byteLength":bytes,"linked":linked,"availability":{"available":true,"reason":null}})
}

pub fn trim_history(workspace: &mut Workspace) {
    let mut bytes: usize = workspace.files.values().flat_map(|file|file.history.iter()).chain(workspace.settings_history.iter()).map(|(_,text)|text.as_ref().map_or(0,String::len)).sum();
    for file in workspace.files.values_mut() { while bytes > SOURCE_SNAPSHOT_BYTES && !file.history.is_empty() { let (_,text) = file.history.remove(0); bytes -= text.as_ref().map_or(0,String::len); } }
    while bytes > SOURCE_SNAPSHOT_BYTES && !workspace.settings_history.is_empty() { let (_,text) = workspace.settings_history.remove(0); bytes -= text.as_ref().map_or(0,String::len); }
}

pub fn rescan(workspace: &mut Workspace) -> Result<bool, Failure> {
    workspace.root.healthy()?;
    let entries = workspace.root.list(MAX_FILES)?;
    let mut disk = BTreeMap::new(); let mut resources = Vec::new(); let mut total = 0usize;
    for entry in entries {
        if entry.path == SETTINGS || text_kind(&entry.path).is_some() {
            if let Some(file) = workspace.root.read(&entry.path, SOURCE_DOCUMENT_BYTES)? {
                total = total.checked_add(file.bytes.len()).ok_or_else(|| failure("too_large", "Project size overflow"))?;
                if total > SOURCE_SNAPSHOT_BYTES { return Err(failure("too_large", "Project sources exceed the snapshot budget")); }
                let text = String::from_utf8(file.bytes).map_err(|_| failure("invalid_source", format!("{} is not UTF-8", entry.path)))?;
                disk.insert(entry.path, (text, file.version));
            }
        } else { resources.push(resource(&workspace.project, &entry.path, entry.bytes, None, false)); }
    }
    // Validate every fallible reconciliation input before publishing any source state.
    let settings_disk = disk.remove(SETTINGS);
    let settings_changed = settings_disk.as_ref().map(|v| &v.1) != workspace.settings_version.as_ref();
    let parsed_settings = if settings_changed && !workspace.settings_dirty() && workspace.settings_conflict.is_none() {
        settings_disk.as_ref().map(|(text,_)| {
            let settings:Settings=serde_json::from_str(text).map_err(|e|failure("invalid_source",format!("Invalid muzpad.json: {e}")))?;
            settings.validate()?; Ok::<_,Failure>(settings)
        }).transpose()?
    } else { None };
    let local_settings = if settings_changed && (workspace.settings_dirty() || workspace.settings_conflict.is_some()) {
        Some(String::from_utf8(workspace.settings.bytes()?).map_err(|_|failure("invalid_source","Settings encoding failed"))?)
    } else { None };
    for file in workspace.files.values() {
        if disk.get(&file.path).map(|v|v.1.as_str()) != file.disk_version.as_deref() && !file.dirty() && file.conflict.is_none() {
            file.version.checked_add(1).filter(|v|*v<=MAX_SAFE).ok_or_else(||failure("resource_budget","Buffer version exhausted"))?;
        }
    }
    let next_disk_generation=workspace.disk_generation.checked_add(1).ok_or_else(||failure("resource_budget","Disk generation exhausted"))?;
    let next_source_version=workspace.source_version.checked_add(1).filter(|v|*v<=MAX_SAFE).ok_or_else(||failure("resource_budget","Source version exhausted"))?;
    let mut changed = false;
    for file in workspace.files.values_mut() {
        let value = disk.remove(&file.path);
        let version = value.as_ref().map(|v| v.1.as_str());
        if version != file.disk_version.as_deref() {
            let text = value.as_ref().map(|v| v.0.as_str());
            let conflict = file.conflict_with(text, version);
            if file.dirty() || file.conflict.is_some() {
                if file.conflict.as_ref() != Some(&conflict) { file.conflict = Some(conflict); changed = true; }
            } else {
                file.history.push((file.disk_version.clone(),file.base.take()));
                if file.history.len() > 4 { file.history.remove(0); }
                file.base = text.map(str::to_owned); file.text = file.base.clone(); file.disk_version = version.map(str::to_owned);
                file.version += 1;
                changed = true;
            }
        } else if file.conflict.take().is_some() { changed = true; }
    }
    if settings_disk.as_ref().map(|v| &v.1) != workspace.settings_version.as_ref() {
        if workspace.settings_dirty() || workspace.settings_conflict.is_some() {
            let next = json!({"fileId":"settings","path":SETTINGS,"base":workspace.settings_base,"local":local_settings,"disk":settings_disk.as_ref().map(|v| &v.0),"baseVersion":workspace.settings_version,"diskVersion":settings_disk.as_ref().map(|v| &v.1),"bufferVersion":workspace.source_version});
            if workspace.settings_conflict.as_ref() != Some(&next) { workspace.settings_conflict = Some(next); changed = true; }
        } else {
            workspace.settings_history.push((workspace.settings_version.clone(),workspace.settings_base.clone()));
            if workspace.settings_history.len() > 4 { workspace.settings_history.remove(0); }
            if let Some(settings) = parsed_settings { workspace.settings = settings; }
            workspace.settings_base = settings_disk.as_ref().map(|v| v.0.clone()); workspace.settings_version = settings_disk.as_ref().map(|v| v.1.clone()); workspace.settings_conflict = None; changed = true;
        }
    } else if workspace.settings_conflict.take().is_some() { changed = true; }
    for (path, (text, version)) in disk {
        let id = stable_file_id(&workspace.project, &path);
        workspace.files.insert(id.clone(), Buffer { id,path,text:Some(text.clone()),base:Some(text),version:0,disk_version:Some(version),conflict:None,history:Vec::new() }); changed = true;
    }
    for pending in workspace.resources.iter().filter(|r| r["pendingSave"] == true || r["linked"] == true) { resources.retain(|r| r["path"] != pending["path"]); resources.push(pending.clone()); }
    if workspace.resources != resources { workspace.resources = resources; changed = true; }
    trim_history(workspace);
    if changed {
        workspace.disk_generation = next_disk_generation;
        workspace.source_version = next_source_version;
    }
    Ok(changed)
}
