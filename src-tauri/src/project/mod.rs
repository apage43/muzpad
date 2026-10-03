mod io;
mod model;
mod operations;
pub mod secure_fs;
mod storage;
mod watch;
#[cfg(all(test, target_os = "linux"))]
mod tests;

pub use secure_fs::stage_export;
use crate::protocol::{Context, Failure, ProjectRef, SOURCE_DOCUMENT_BYTES, SOURCE_SNAPSHOT_BYTES};
use io::{Grant, Imported};
use model::*;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet, VecDeque}, path::{Path, PathBuf}, sync::Arc};
use secure_fs::Root;
use storage::Storage;
use watch::{EventSink, ProjectWatcher, SharedWorkspace};

struct ClosePermit { token: String, fingerprint: String, reason: String, ticket: Option<String>, decision: String }
struct CapturedSnapshot { descriptor: Value, root: PathBuf, files: Vec<(Value, String)>, baselines: Vec<(String, String, Option<String>)>, bytes: usize, dependencies: Mutex<Option<Vec<(String,String,String)>>> }
pub struct ProjectService {
    state: SharedWorkspace,
    storage: Storage,
    workspace_dir: PathBuf,
    resource_dir: PathBuf,
    grants: Vec<Grant>,
    recents: Vec<Value>,
    offers: Vec<Value>,
    snapshots: BTreeMap<String, CapturedSnapshot>,
    snapshot_order: VecDeque<String>,
    retained: Option<String>,
    previous_snapshot: Option<String>,
    event: EventSink,
    watcher: ProjectWatcher,
    permit: Option<ClosePermit>,
    replacement: Option<String>,
    close_ticket: Option<String>,
    allow_exit: bool,
}
impl ProjectService {
    pub fn new(data_dir: PathBuf, config_dir: PathBuf, resource_dir: PathBuf, event: EventSink) -> Result<Self, Failure> {
        let storage = Storage::new(data_dir.clone(),config_dir)?;
        let workspace_dir = data_dir.join("workspaces");
        create_private_dir(&workspace_dir)?;
        let recents = storage.load_recents()?;
        let offers = storage.recovery_records()?.iter().map(offer).collect();
        let grants = io::boot_grants(&resource_dir,&event)?;
        let state = Arc::new(Mutex::new(None));
        let watcher = ProjectWatcher::start(state.clone(),event.clone());
        let service = Self { state,storage,workspace_dir,resource_dir,grants,recents,offers,snapshots:BTreeMap::new(),snapshot_order:VecDeque::new(),retained:None,previous_snapshot:None,event,watcher,permit:None,replacement:None,close_ticket:None,allow_exit:false };
        service.reclaim_private_workspaces();
        Ok(service)
    }
    pub fn current(&self) -> Option<Value> { self.state.lock().as_ref().map(Workspace::snapshot) }
    pub fn current_ref(&self) -> Option<ProjectRef> { self.state.lock().as_ref().map(|w| ProjectRef { project:w.project.clone(),epoch:w.epoch.clone() }) }
    pub fn recovery_offers(&self) -> Vec<Value> { self.offers.clone() }
    pub fn retained_snapshot(&self) -> Option<String> { self.retained.clone() }
    pub fn retain_accepted_snapshot(&mut self, id: &str) -> Result<(), Failure> {
        let snapshot = self.snapshots.get(id).ok_or_else(|| failure("stale_request", "Accepted source snapshot expired"))?;
        let current = self.current_ref().ok_or_else(|| failure("stale_request", "No open project"))?;
        if snapshot.descriptor["project"] != current.project || snapshot.descriptor["epoch"] != current.epoch { return Err(failure("stale_request", "Accepted snapshot belongs to a previous project")); }
        if self.retained.as_deref() != Some(id) { self.previous_snapshot = self.retained.replace(id.to_owned()); }
        Ok(())
    }
    pub fn choose_library_grant(&mut self, required: &str) -> Result<bool, Failure> {
        if self.current_ref().is_none() || !Path::new(required).is_absolute() { return Err(failure("denied_path", "Library access requires a current project and absolute dependency identity")); }
        let requested = Path::new(required).canonicalize().map_err(|_| failure("missing_module", "Requested library file is missing or inaccessible"))?;
        let Some(directory) = rfd::FileDialog::new().set_title("Authorize the library folder containing the requested resource").pick_folder() else { return Ok(false); };
        let root = Arc::new(Root::open(&directory)?);
        let relative = requested.strip_prefix(root.path()).map_err(|_| failure("denied_path", "Selected folder does not contain the required resource"))?.to_str().ok_or_else(|| failure("denied_path", "Library path is not UTF-8"))?.to_owned();
        if root.fingerprint(&relative,MAX_ASSETS)?.is_none() { return Err(failure("missing_module", "Selected folder does not contain the required file")); }
        if self.grants.iter().any(|g| g.root.path() == root.path() && g.kind == "library") { return Ok(true); }
        let id = format!("external:{}", opaque());
        let path = root.path().to_owned();
        let mut guard = self.state.lock(); let workspace = guard.as_mut().ok_or_else(|| failure("stale_request", "Project was closed during library selection"))?;
        workspace.resources.push(json!({"id":id,"path":path,"kind":"library","version":null,"byteLength":null,"linked":true,"availability":{"available":true,"reason":null}}));
        workspace.source_version = workspace.source_version.checked_add(1).filter(|v| *v <= MAX_SAFE).ok_or_else(|| failure("resource_budget", "Source version exhausted"))?;
        let snapshot = workspace.snapshot(); drop(guard);
        self.grants.push(Grant { id,kind:"library",path,root,exact:None });
        self.permit = None; self.replacement = None;
        self.persist_current()?;
        self.emit_changed(snapshot,"disk");
        Ok(true)
    }
    pub fn close_allowed(&self) -> bool { self.allow_exit }
    pub fn set_close_ticket(&mut self, ticket: String) { self.close_ticket = Some(ticket); self.permit = None; self.allow_exit = false; }
    pub fn read_grants(&self) -> Vec<Value> {
        let mut grants: Vec<Value> = self.grants.iter().map(Grant::dto).collect();
        if let Some(workspace) = self.state.lock().as_ref() { grants.push(json!({"id":project_grant(&workspace.project),"kind":"project","path":workspace.root.path()})); }
        grants
    }
    pub fn snapshot_transfer(&self, id: &str) -> Result<(Value,Vec<(Value,String)>),Failure> {
        let snapshot = self.snapshots.get(id).ok_or_else(|| failure("stale_request", "Source snapshot expired"))?;
        Ok((snapshot.descriptor.clone(),snapshot.files.clone()))
    }
    pub fn validate_snapshot(&self, id: &str, dependencies: &Value) -> Result<(), Failure> {
        self.validate_snapshot_authority(id,dependencies,false)
    }
    pub fn validate_retained_snapshot(&self, id: &str, dependencies: &Value) -> Result<(), Failure> {
        if self.retained.as_deref() != Some(id) { return Err(failure("stale_request","Restart requires the currently accepted source snapshot")); }
        self.validate_snapshot_authority(id,dependencies,true)
    }
    fn validate_snapshot_authority(&self, id: &str, dependencies: &Value, retained: bool) -> Result<(), Failure> {
        let snapshot = self.snapshots.get(id).ok_or_else(|| failure("stale_request", "Source snapshot expired"))?;
        let guard = self.state.lock(); let workspace = guard.as_ref().ok_or_else(|| failure("stale_request", "No open project"))?;
        if snapshot.descriptor["project"] != workspace.project || snapshot.descriptor["epoch"] != workspace.epoch || (!retained && snapshot.descriptor["sourceVersion"] != workspace.source_version) { return Err(failure("stale_request", "Project changed while compiling; capture current sources")); }
        if !retained && !workspace.conflicts().is_empty() { return Err(failure("source_conflict", "Resolve source conflicts before applying this build")); }
        for (grant,path,expected) in &snapshot.baselines {
            // Accepted project text/settings are already immutable captured authority,
            // not disk reads. Only explicit restart may outlive their save baselines.
            if retained && grant == &project_grant(&workspace.project) { continue; }
            let actual = self.dependency_version(workspace,grant,path)?;
            if &actual != expected { return Err(failure("source_conflict", format!("Captured dependency changed: {path}"))); }
        }
        let dependencies = dependencies.as_array().ok_or_else(|| failure("protocol_mismatch", "Engine dependency versions must be an array"))?;
        if dependencies.len() > MAX_FILES { return Err(failure("resource_budget", "Too many engine dependencies")); }
        let mut unique = BTreeSet::new();
        let mut consumed = Vec::with_capacity(dependencies.len());
        let mut watches = Vec::new();
        for dependency in dependencies {
            let grant = field(dependency,"grant")?; let path = field(dependency,"path")?; let version = field(dependency,"version")?;
            let normalized;
            let path = if grant == project_grant(&workspace.project) && Path::new(path).is_absolute() {
                normalized = Path::new(path).strip_prefix(workspace.root.path()).or_else(|_| Path::new(path).strip_prefix(&snapshot.root)).map_err(|_| failure("denied_path","Dependency is outside the captured project"))?.to_str().ok_or_else(|| failure("denied_path","Non-UTF8 dependency"))?.to_owned();
                normalized.as_str()
            } else { path };
            if !unique.insert((grant,path.to_owned())) { return Err(failure("protocol_mismatch", "Duplicate engine dependency")); }
            consumed.push((grant.to_owned(),path.to_owned(),version.to_owned()));
            let pinned = snapshot.files.iter().find(|(file,_)| {
                let file_path = file["path"].as_str().unwrap_or("");
                if grant == project_grant(&workspace.project) { file_path == path || workspace.root.path().join(file_path) == Path::new(path) }
                else { self.grants.iter().find(|g| g.id == grant).and_then(|g| g.relative(path).ok().map(|relative| g.root.path().join(relative))).is_some_and(|p| p == Path::new(file_path)) }
            });
            if let Some((_,text)) = pinned { if digest(text.as_bytes()) != version { return Err(failure("source_conflict", format!("Engine used a different captured source: {path}"))); } }
            else if self.dependency_version(workspace,grant,path)?.as_deref() != Some(version) { return Err(failure("changed_asset", format!("Consumed dependency changed: {path}"))); }
            if let Some(authority) = self.grants.iter().find(|g| g.id == grant) {
                watches.push((authority.root.clone(),authority.relative(path)?,version.to_owned()));
            } else if pinned.is_none() && grant == project_grant(&workspace.project) {
                let relative = if Path::new(path).is_absolute() { Path::new(path).strip_prefix(workspace.root.path()).map_err(|_| failure("denied_path","Dependency is outside project"))?.to_str().ok_or_else(|| failure("denied_path","Dependency is not UTF-8"))?.to_owned() } else { path.to_owned() };
                watches.push((workspace.root.clone(),relative,version.to_owned()));
            }
        }
        consumed.sort();
        let mut original = snapshot.dependencies.lock();
        if original.as_ref().is_some_and(|first| first != &consumed) { return Err(failure("changed_asset", "Rebuilding this immutable snapshot would consume different asset versions")); }
        if original.is_none() { *original = Some(consumed); }
        for (root,path,version) in watches { self.watcher.observe(&workspace.epoch,root,path,Some(version))?; }
        Ok(())
    }
    fn dependency_version(&self, workspace: &Workspace, grant: &str, path: &str) -> Result<Option<String>, Failure> {
        if grant == project_grant(&workspace.project) {
            let relative = if Path::new(path).is_absolute() { Path::new(path).strip_prefix(workspace.root.path()).map_err(|_| failure("denied_path", "Dependency is outside project"))?.to_str().ok_or_else(|| failure("denied_path", "Non-UTF8 dependency"))? } else { path };
            return workspace.root.fingerprint(relative,MAX_ASSETS);
        }
        let authority = self.grants.iter().find(|g| g.id == grant).ok_or_else(|| failure("grant_required", "Engine referenced an unauthorized root"))?;
        authority.root.fingerprint(&authority.relative(path)?,MAX_ASSETS)
    }
    pub fn dispatch(&mut self, method: &str, payload: Value, context: &Context) -> Result<Value,Failure> {
        let result = match method {
            "preferences.load" => self.storage.load_preferences(),
            "preferences.save" => { self.storage.save_preferences(payload.get("value").ok_or_else(|| failure("invalid_source", "Missing preferences"))?)?; Ok(Value::Null) },
            "project.listRecent" => self.list_recent(),
            "project.chooseFolder" => { self.check_replacement()?; match rfd::FileDialog::new().set_title("Open muzpad project folder").pick_folder() { Some(path) => self.open_folder(path,None),None => Ok(Value::Null) } },
            "project.openRecent" => { self.check_replacement()?; let id = field(&payload,"project")?; let recent = self.recents.iter().find(|r| r["project"] == id).cloned().ok_or_else(|| failure("stale_request", "Unknown recent project"))?; let root = PathBuf::from(field(&recent,"root")?); let authority = Root::open(&root).map_err(|_| failure("project_missing", "Recent project is missing or inaccessible; choose its moved folder explicitly"))?; if recent["rootIdentity"] != authority.identity() { return Err(failure("source_conflict", "Recent project root was replaced; choose the folder explicitly")); } self.open_folder(root,Some(id.to_owned())) },
            "project.newProject" => { self.check_replacement()?; let settings: Settings = decode(payload["settings"].clone())?; settings.validate()?; let mut workspace = self.unsaved(settings.clone(),None)?; let id = stable_file_id(&workspace.project,&settings.entry); workspace.files.insert(id.clone(),Buffer { id,path:settings.entry.clone(),text:Some(String::new()),version:1,base:None,disk_version:None,conflict:None,history:Vec::new() }); workspace.source_version = 1; self.install(workspace) },
            "project.importProject" => self.import_project(payload["input"].clone()),
            "project.readLibraryDocument" => self.library_document(&payload["input"]),
            "project.resolveSourceDocument" => self.resolve_source_document(&payload["input"]),
            "project.save" => { let input: SaveInput = decode(payload["input"].clone())?; self.save(input,context.source_version) },
            "project.refresh" => { let capture: WorkingCapture = decode(payload["input"].clone())?; self.acknowledge(&capture)?; let state = self.state.clone(); let mut guard = state.lock(); let workspace = guard.as_mut().ok_or_else(|| failure("stale_request", "No open project"))?; rescan(workspace)?; let snapshot = workspace.snapshot(); drop(guard); self.emit_changed(snapshot.clone(),"disk"); Ok(snapshot) },
            "project.resolveConflict" => self.resolve_conflict(&payload["input"]),
            "project.snapshotSources" => { let capture: WorkingCapture = decode(payload["input"].clone())?; self.capture_sources(capture) },
            "project.persistRecovery" => { let capture: WorkingCapture = decode(payload["input"].clone())?; self.acknowledge(&capture)?; self.persist_current()?; Ok(Value::Null) },
            "project.restoreRecovery" => self.restore_recovery(&payload["input"]),
            "project.exportArchive" => { let capture: WorkingCapture = decode(payload["input"].clone())?; self.archive(capture) },
            "project.reveal" => self.reveal(&payload["input"]),
            "project.prepareClose" => self.prepare_close(&payload["input"],payload.get("_activeExports").and_then(Value::as_u64).unwrap_or(0)),
            "project.close" => self.close(&payload["input"]),
            _ => Err(failure("protocol_mismatch", "Unknown project command")),
        };
        result.map_err(|mut error| { error.request_id = Some(context.request_id.clone()); error })
    }
    fn acknowledge(&mut self, capture: &WorkingCapture) -> Result<(),Failure> {
        let mut guard = self.state.lock(); let workspace = guard.as_mut().ok_or_else(|| failure("stale_request", "No open project"))?;
        workspace.acknowledge(capture)?;
        if self.replacement.as_ref().is_some_and(|v| v != &workspace_fingerprint(workspace)) { self.replacement = None; }
        let reconciled = capture.source_version != workspace.source_version || capture.expected_disk_generation != workspace.disk_generation.to_string();
        let snapshot = reconciled.then(|| workspace.snapshot());
        drop(guard);
        if let Some(snapshot) = snapshot { self.emit_changed(snapshot,"conflict"); }
        Ok(())
    }
    fn unsaved(&self, settings: Settings, project: Option<String>) -> Result<Workspace, Failure> {
        self.reclaim_private_workspaces_checked()?;
        let id = project.unwrap_or_else(opaque);
        if id.is_empty() || id.len() > 128 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c,b'-'|b'_')) { return Err(failure("invalid_source", "Invalid durable project identity")); }
        let directory = self.workspace_dir.join(&id); create_private_dir(&directory)?;
        let root = Arc::new(Root::open(&directory)?);
        Ok(Workspace { project:id,epoch:opaque(),root,persisted:false,gist:None,settings,settings_base:None,settings_version:None,settings_conflict:None,source_version:0,disk_generation:0,files:BTreeMap::new(),resources:Vec::new(),asset_origin:None,acknowledged_source:0,settings_history:Vec::new(),recent_saves:BTreeMap::new() })
    }
    fn check_replacement(&self) -> Result<(),Failure> {
        if let Some(workspace) = self.state.lock().as_ref() { if workspace.dirty() && self.replacement.as_deref() != Some(&workspace_fingerprint(workspace)) { return Err(failure("close_required", "Save or explicitly discard the current project before replacement")); } }
        Ok(())
    }
    fn install(&mut self, workspace: Workspace) -> Result<Value, Failure> {
        self.check_replacement()?;
        // Retain the previous workspace until all new-project I/O has succeeded.
        if self.state.lock().is_some() { self.persist_current()?; }
        if workspace.persisted { self.record_recent(&workspace)?; }
        let initial_recovery = if workspace.dirty() {
            let record = operations::recovery_record(&workspace,&[]);
            self.storage.put_recovery(&record)?;
            Some(offer(&record))
        } else { None };
        let snapshot = workspace.snapshot();
        self.watcher.reset();
        self.watcher.watch(workspace.root.path());
        for file in workspace.files.values() { if let Some(parent) = workspace.root.path().join(&file.path).parent() { self.watcher.watch(parent); } }
        *self.state.lock() = Some(workspace);
        self.permit = None; self.replacement = None; self.allow_exit = false; self.retained = None; self.previous_snapshot = None;
        self.snapshots.clear(); self.snapshot_order.clear();
        self.grants.retain(|g| !g.id.starts_with("external:"));
        if let Some(recovery) = initial_recovery { self.offers.retain(|value| value["id"] != recovery["id"]); self.offers.push(recovery.clone()); (self.event)(json!({"kind":"recovery","offer":recovery})); }
        self.reclaim_private_workspaces();
        Ok(snapshot)
    }
    fn open_folder(&mut self, path: PathBuf, requested: Option<String>) -> Result<Value,Failure> {
        let root = Arc::new(Root::open(&path)?);
        let identity = root.identity();
        let id = requested.or_else(|| self.recents.iter().find(|r| r["rootIdentity"] == identity).and_then(|r| r["project"].as_str()).map(str::to_owned)).unwrap_or_else(opaque);
        let recovery = root.recover(self.storage.journal_dir())?;
        let mut workspace = io::read_workspace(root,true,id)?;
        workspace.gist = self.recents.iter().find(|row| row["project"] == workspace.project).and_then(|row| row["gist"].as_str()).map(str::to_owned);
        let reference = workspace.project_ref();
        let result = self.install(workspace)?;
        for record in recovery { (self.event)(json!({"kind":"failure","project":reference,"failure":failure("recovery_required",format!("Interrupted save preserved both versions: {record}"))})); }
        Ok(result)
    }
    fn record_recent(&mut self, workspace: &Workspace) -> Result<(),Failure> {
        let row = with_gist(json!({"project":workspace.project,"title":workspace.settings.title,"rootLabel":workspace.root_label(),"root":workspace.root.path(),"rootIdentity":workspace.root.identity(),"available":true,"lastOpened":storage::timestamp()}), workspace.gist.as_deref());
        let mut rows = self.recents.clone(); rows.retain(|r| r["project"] != workspace.project); rows.insert(0,row); rows.truncate(128);
        self.storage.save_recents(&rows)?; self.recents = rows; Ok(())
    }
    fn list_recent(&self) -> Result<Value,Failure> {
        Ok(Value::Array(self.recents.iter().map(|r| { let available = r["root"].as_str().and_then(|p| Root::open(Path::new(p)).ok()).is_some_and(|root| r["rootIdentity"] == root.identity()); with_gist(json!({"project":r["project"],"title":r["title"],"rootLabel":r["rootLabel"],"available":available,"lastOpened":r["lastOpened"]}), r["gist"].as_str()) }).collect()))
    }
    fn import_project(&mut self, input: Value) -> Result<Value,Failure> {
        self.check_replacement()?;
        let imported: Imported = match field(&input,"kind")? {
            "content" => decode(input["project"].clone())?,
            "zipDialog" => { let Some(path) = rfd::FileDialog::new().set_title("Import project ZIP").add_filter("ZIP archive", &["zip"]).pick_file() else { return Ok(Value::Null); }; io::import_zip(&path)? },
            _ => return Err(failure("invalid_source", "Unknown project import kind")),
        };
        let mut workspace = self.unsaved(imported.settings.clone(),None)?;
        let result = io::populate_import(&mut workspace,imported,self.storage.journal_dir()).and_then(|()| self.install(workspace));
        self.reclaim_private_workspaces();
        result
    }
    pub fn resolve_source_document(&self, input: &Value) -> Result<Value,Failure> {
        let guard = self.state.lock(); let workspace = guard.as_ref().ok_or_else(|| failure("stale_request","No open project"))?;
        workspace.assert_ref(field(&input["project"],"project")?,field(&input["project"],"epoch")?)?;
        let path = field(input,"path")?;
        workspace.root.healthy()?;
        let retained_root = self.retained.as_ref().and_then(|id| self.snapshots.get(id)).filter(|snapshot| snapshot.descriptor["project"] == workspace.project && snapshot.descriptor["epoch"] == workspace.epoch).map(|snapshot|snapshot.root.as_path());
        let relative = if Path::new(path).is_absolute() {
            Path::new(path).strip_prefix(workspace.root.path()).ok().or_else(|| retained_root.and_then(|root|Path::new(path).strip_prefix(root).ok())).and_then(Path::to_str)
        } else { Some(path) };
        if let Some(relative) = relative {
            secure_fs::validate_path(relative)?;
            if let Some(file) = workspace.files.values().find(|file| file.path == relative && file.text.is_some()) {
                // Check ancestors without requiring an unsaved editable buffer to exist.
                workspace.root.fingerprint(relative,SOURCE_DOCUMENT_BYTES as u64)?;
                return Ok(json!({"kind":"project","path":file.path,"fileId":file.id}));
            }
            if !Path::new(path).is_absolute() {
                drop(guard);
                let id = format!("library:{path}");
                let document = match self.library_document(&json!({"project":input["project"],"id":id})) {
                    Ok(document) => document,
                    Err(error) if error.code == "missing_module" => return Ok(Value::Null),
                    Err(error) => return Err(error),
                };
                let document_path = field(&document,"path")?;
                let normalized = path.trim_end_matches(".muz");
                let standard = muz::lang::STANDARD_MODULES.iter().any(|(name,_)| *name == normalized || format!("library/{name}") == normalized);
                let canonical = if standard { document_path.to_owned() } else {
                    let grant_id = if path.starts_with("contrib/") && self.grants.iter().any(|grant|grant.id == "contrib") { "contrib" } else { "library" };
                    let grant = self.grants.iter().find(|grant| grant.id == grant_id).ok_or_else(|| failure("missing_module","Source library is unavailable"))?;
                    grant.root.path().join(grant.relative(document_path)?).to_str().ok_or_else(|| failure("denied_path","Document identity is not UTF-8"))?.to_owned()
                };
                return Ok(json!({"kind":"library","id":id,"path":canonical,"text":document["text"],"documentKind":document["kind"]}));
            }
            return Ok(Value::Null);
        }
        let Some((grant,relative)) = self.grants.iter().filter(|grant| matches!(grant.kind,"library"|"config")).find_map(|grant| grant.relative(path).ok().map(|relative|(grant,relative))) else {
            return Err(failure("denied_path","Source identity is outside authorized document roots"));
        };
        let Some(document_kind) = text_kind(&relative) else { return Ok(Value::Null); };
        if grant.root.fingerprint(&relative,SOURCE_DOCUMENT_BYTES as u64)?.is_none() { return Ok(Value::Null); }
        let absolute = grant.root.path().join(&relative).to_str().ok_or_else(|| failure("denied_path","Document identity is not UTF-8"))?.to_owned();
        let id = format!("library:{absolute}");
        drop(guard);
        let document = match self.library_document(&json!({"project":input["project"],"id":id})) {
            Ok(document) => document,
            Err(error) if error.code == "missing_module" => return Ok(Value::Null),
            Err(error) => return Err(error),
        };
        Ok(json!({"kind":"library","id":id,"path":absolute,"text":document["text"],"documentKind":document_kind}))
    }
    fn reclaim_private_workspaces(&self) {
        if let Err(error) = self.reclaim_private_workspaces_checked() {
            (self.event)(json!({"kind":"failure","project":self.current_ref(),"failure":error}));
        }
    }
    fn reclaim_private_workspaces_checked(&self) -> Result<(),Failure> {
        // Recovery must be readable before deletion: a storage failure cannot turn
        // a recoverable asset root into an apparently unreferenced directory.
        let records = self.storage.recovery_records()?;
        let mut referenced = BTreeSet::new();
        for record in records { for key in ["root","assetOrigin"] { if let Some(path) = record[key].as_str() { referenced.insert(PathBuf::from(path)); } } }
        if let Some(workspace) = self.state.lock().as_ref() {
            referenced.insert(workspace.root.path().to_owned());
            if let Some(origin) = &workspace.asset_origin { referenced.insert(origin.path().to_owned()); }
        }
        let parent = Root::open(&self.workspace_dir)?;
        // Each pass has bounded filesystem work; startup and every lifecycle
        // transition reclaim older crash orphans without an unbounded traversal.
        for entry in std::fs::read_dir(parent.path())?.take(128) {
            let entry = entry?; let path = entry.path();
            let name = entry.file_name(); let Some(name) = name.to_str() else { continue; };
            if name.is_empty() || name.len() > 128 || !name.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c,b'-'|b'_')) || referenced.contains(&path) { continue; }
            parent.healthy()?;
            if entry.file_type()?.is_dir() { std::fs::remove_dir_all(&path)?; }
            else if entry.file_type()?.is_symlink() { std::fs::remove_file(&path)?; }
        }
        Ok(())
    }
    fn library_document(&self, input: &Value) -> Result<Value,Failure> {
        if !input["project"].is_null() { let guard = self.state.lock(); let workspace = guard.as_ref().ok_or_else(|| failure("stale_request", "No open project"))?; workspace.assert_ref(field(&input["project"],"project")?,field(&input["project"],"epoch")?)?; }
        let id = field(input,"id")?;
        let lookup = id.strip_prefix("library:").unwrap_or(id);
        if let Some(snapshot) = self.retained.as_ref().and_then(|key| self.snapshots.get(key)) {
            if let Some((file,text)) = snapshot.files.iter().find(|(file,_)| file["fileId"] == lookup || (Path::new(lookup).is_absolute() && file["path"] == lookup)) {
                let path = field(file,"path")?;
                return Ok(json!({"id":id,"path":path,"text":text,"kind":text_kind(path).unwrap_or("text")}));
            }
        }
        let normalized = lookup.trim_end_matches(".muz");
        if let Some((name,text)) = muz::lang::STANDARD_MODULES.iter().find(|(name,_)| *name == normalized || format!("library/{name}") == normalized) { return Ok(json!({"id":id,"path":format!("{name}.muz"),"text":text,"kind":"source"})); }
        let (grant,path) = if lookup == "plugin-config" { let grant = self.grants.iter().find(|g| g.id == lookup).ok_or_else(|| failure("missing_module", "No plugin configuration is installed"))?; (grant,grant.exact.clone().ok_or_else(|| failure("denied_path", "Plugin config has no exact document"))?) }
        else if Path::new(lookup).is_absolute() {
            self.grants.iter().filter(|g| matches!(g.kind,"library"|"config")).find_map(|g|g.relative(lookup).ok().map(|path|(g,path))).ok_or_else(|| { let mut error = failure("grant_required","This document is outside authorized libraries"); error.path = Some(lookup.into()); error })?
        } else {
            let native = lookup.strip_prefix("contrib/").and_then(|path| self.grants.iter().find(|g|g.id == "contrib").map(|grant|(grant,path)));
            let (grant,relative) = match native { Some(pair) => pair, None => (self.grants.iter().find(|g| g.id == "library").ok_or_else(|| failure("missing_module", "Packaged source library is unavailable"))?,lookup.strip_prefix("library/").unwrap_or(lookup)) };
            let path = if text_kind(relative).is_some() { relative.to_owned() } else { format!("{relative}.muz") };
            (grant,path)
        };
        secure_fs::validate_path(&path)?;
        let file = grant.root.read(&path,SOURCE_DOCUMENT_BYTES)?.ok_or_else(|| failure("missing_module", format!("Library document not found: {id}")))?;
        let text = String::from_utf8(file.bytes).map_err(|_| failure("invalid_source", "Library document is not UTF-8"))?;
        Ok(json!({"id":id,"path":path,"text":text,"kind":text_kind(&path).unwrap_or("text")}))
    }
    fn emit_changed(&self, snapshot: Value, reason: &str) { (self.event)(json!({"kind":"changed","snapshot":snapshot,"reason":reason})); }
    pub fn shutdown(&mut self) -> Result<(),Failure> { self.watcher.stop(); if self.state.lock().as_ref().is_some_and(Workspace::dirty) { self.persist_current()?; } Ok(()) }
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, Failure> { value.get(key).and_then(Value::as_str).ok_or_else(|| failure("invalid_source", format!("Missing string field {key}"))) }
fn project_grant(project: &str) -> String { format!("project:{project}") }
fn workspace_fingerprint(workspace: &Workspace) -> String { digest(serde_json::to_vec(&workspace.working_capture()).expect("serializable capture").as_slice()) }
fn offer(record: &Value) -> Value { json!({"id":record["id"],"project":record["project"],"title":record["title"],"rootLabel":record["rootLabel"],"updatedAt":record["updatedAt"]}) }
fn create_private_dir(path: &Path) -> Result<(),Failure> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) { if metadata.file_type().is_symlink() || !metadata.is_dir() { return Err(failure("denied_path", "Private workspace directory is not a real directory")); } }
    else { let mut builder = std::fs::DirBuilder::new(); #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); } builder.create(path)?; }
    Ok(())
}
