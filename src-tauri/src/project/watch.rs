use super::{model::{failure, rescan, Workspace, MAX_ASSETS, MAX_FILES, MAX_SAFE}, secure_fs::Root};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::{Path, PathBuf}, sync::{Arc, atomic::{AtomicBool, Ordering}}, thread::{self, JoinHandle}, time::{Duration, Instant}};

pub type SharedWorkspace = Arc<Mutex<Option<Workspace>>>;
pub type EventSink = Arc<dyn Fn(Value) + Send + Sync>;
#[derive(Clone)]
struct Dependency { epoch: String, root: Option<Arc<Root>>, path: String, canonical:Option<PathBuf>, version: Option<String> }
pub(super) struct WatchSnapshot { dependencies:Vec<Dependency>,paths:BTreeSet<PathBuf> }
fn reconcile_dependencies(workspace:&mut Workspace,dependencies:&mut [Dependency])->(bool,Option<crate::protocol::Failure>){
    let mut changed=false;let mut error=None;
    for dependency in dependencies.iter_mut().filter(|dependency|dependency.epoch==workspace.epoch){
        let version=if let Some(root)=&dependency.root{root.fingerprint(&dependency.path,MAX_ASSETS)}
            else{crate::engine::sources::account_fingerprint(Path::new(&dependency.path),MAX_ASSETS).map(|actual|actual.map(|(canonical,version)|{
                if dependency.canonical.as_ref()!=Some(&canonical){dependency.canonical=Some(canonical);changed=true;}version
            }))};
        match version{
            Ok(version)=>{if version!=dependency.version{dependency.version=version;changed=true;}},
            Err(failure)=>{if dependency.version.take().is_some(){changed=true;}error=Some(failure);},
        }
    }
    if changed{
        match(workspace.source_version.checked_add(1).filter(|version|*version<=MAX_SAFE),workspace.disk_generation.checked_add(1)){
            (Some(source),Some(disk))=>{workspace.source_version=source;workspace.disk_generation=disk;},
            _=>error=Some(failure("resource_budget","Project version exhausted")),
        }
    }
    (changed,error)
}
fn signal_notification(result: notify::Result<notify::Event>, hint: &AtomicBool, failed: &AtomicBool) {
    if match result { Ok(event) => event.need_rescan(), Err(_) => true } { failed.store(true,Ordering::Release); }
    hint.store(true,Ordering::Release);
}

pub struct ProjectWatcher {
    watcher: Mutex<Option<RecommendedWatcher>>,
    paths: Mutex<BTreeSet<PathBuf>>,
    dependencies: Arc<Mutex<Vec<Dependency>>>,
    restoration_failure:Arc<Mutex<Option<(String,crate::protocol::Failure)>>>,
    failed: Arc<AtomicBool>,
    hint: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl ProjectWatcher {
    pub fn start(state: SharedWorkspace, event: EventSink) -> Self {
        let hint = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let dependencies: Arc<Mutex<Vec<Dependency>>> = Arc::new(Mutex::new(Vec::new()));
        let worker_dependencies = dependencies.clone();
        let restoration_failure=Arc::new(Mutex::new(None::<(String,crate::protocol::Failure)>));let worker_restoration=restoration_failure.clone();
        let worker_failed = failed.clone();
        let flag = hint.clone(); let error_flag = failed.clone();
        let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            signal_notification(result,&flag,&error_flag);
        }).ok();
        if watcher.is_none() { failed.store(true, Ordering::Release); }
        let worker_stop = stop.clone(); let worker_hint = hint.clone();
        let thread = thread::Builder::new().name("muzpad-project-watch".into()).spawn(move || {
            let mut last_scan = Instant::now(); let mut reported: Option<(String, String)> = None;
            while !worker_stop.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(250));
                if !worker_hint.swap(false, Ordering::AcqRel) && last_scan.elapsed() < Duration::from_secs(5) { continue; }
                last_scan = Instant::now();
                let mut events = Vec::new();
                {
                    let mut current = state.lock();
                    if let Some(workspace) = current.as_mut() {
                        let project = workspace.project_ref();
                        let mut result = rescan(workspace);
                        let (dependency_changed,dependency_failure)=reconcile_dependencies(workspace,&mut worker_dependencies.lock());
                        if let Some((epoch,error))=worker_restoration.lock().take(){if epoch==workspace.epoch{result=Err(error);}}
                        if let Some(error)=dependency_failure{result=Err(error);}
                        let degraded = worker_failed.load(Ordering::Acquire);
                        let status = if workspace.root.healthy().is_err() { "rootMissing" } else if degraded || result.is_err() { "degraded" } else { "ready" };
                        let key = (workspace.epoch.clone(), status.to_owned());
                        if reported.as_ref() != Some(&key) {
                            let error = result.as_ref().err().cloned().or_else(|| degraded.then(|| failure("watch_unavailable", "Filesystem notifications are unavailable or overflowed; bounded periodic rescanning is active")));
                            events.push(json!({"kind":"watch","project":project,"state":status,"failure":error})); reported = Some(key);
                        }
                        if dependency_changed||matches!(result,Ok(true)){events.push(json!({"kind":"changed","snapshot":workspace.snapshot(),"reason":"disk"}));}
                    }
                }
                // Never call the shell while holding the workspace mutex.
                for value in events { event(value); }
            }
        }).ok();
        if thread.is_none() { failed.store(true, Ordering::Release); }
        Self { watcher: Mutex::new(watcher), paths: Mutex::new(BTreeSet::new()), dependencies, restoration_failure,failed, hint, stop, thread }
    }
    pub fn watch(&self, path: &Path) {
        let mut paths = self.paths.lock();
        if paths.contains(path) { return; }
        if paths.len() >= MAX_FILES { self.failed.store(true, Ordering::Release); return; }
        if let Some(watcher) = self.watcher.lock().as_mut() { if watcher.watch(path, RecursiveMode::NonRecursive).is_err() { self.failed.store(true, Ordering::Release); } else { paths.insert(path.to_owned()); } }
        self.hint.store(true, Ordering::Release);
    }
    pub fn observe(&self, epoch: &str, root: Arc<Root>, path: String, version: Option<String>) -> Result<(), crate::protocol::Failure> {
        self.watch(&root.path().join(&path));
        if let Some(parent)=root.path().join(&path).parent(){self.watch(parent);}
        let mut dependencies = self.dependencies.lock();
        if let Some(existing) = dependencies.iter_mut().find(|d| d.epoch == epoch && d.root.as_ref().is_some_and(|stored|stored.path()==root.path()) && d.path == path) { existing.version = version; return Ok(()); }
        if dependencies.len() >= MAX_FILES { return Err(failure("resource_budget", "Too many watched dependencies")); }
        dependencies.push(Dependency { epoch:epoch.into(),root:Some(root),path,canonical:None,version }); Ok(())
    }
    pub fn observe_account(&self,epoch:&str,path:PathBuf,canonical:PathBuf,version:String)->Result<(),crate::protocol::Failure> {
        for file in [&path,&canonical] {self.watch(file);if let Some(parent)=file.parent(){self.watch(parent);}}
        let path=path.to_str().ok_or_else(||failure("denied_path","Dependency path must be UTF-8"))?.to_owned();
        let mut dependencies=self.dependencies.lock();
        if let Some(existing)=dependencies.iter_mut().find(|d|d.epoch==epoch&&d.root.is_none()&&d.path==path){existing.version=Some(version);existing.canonical=Some(canonical);return Ok(());}
        if dependencies.len()>=MAX_FILES{return Err(failure("resource_budget","Too many consumed dependencies"));}
        dependencies.push(Dependency{epoch:epoch.into(),root:None,path,canonical:Some(canonical),version:Some(version)});Ok(())
    }
    pub fn checkpoint(&self)->WatchSnapshot{WatchSnapshot{dependencies:self.dependencies.lock().clone(),paths:self.paths.lock().clone()}}
    pub fn restore(&self,snapshot:WatchSnapshot,workspace:&mut Workspace){
        for path in snapshot.paths{self.watch(&path);}
        *self.dependencies.lock()=snapshot.dependencies;
        let root_error=rescan(workspace).err();
        let (_,dependency_error)=reconcile_dependencies(workspace,&mut self.dependencies.lock());
        let canonical:Vec<PathBuf>=self.dependencies.lock().iter().filter_map(|dependency|dependency.canonical.clone()).collect();
        for path in canonical{self.watch(&path);if let Some(parent)=path.parent(){self.watch(parent);}}
        *self.restoration_failure.lock()=dependency_error.or(root_error).map(|error|(workspace.epoch.clone(),error));
        self.hint.store(true,Ordering::Release);
    }
    pub fn reset(&mut self) {
        self.dependencies.lock().clear();
        self.restoration_failure.lock().take();
        if let Some(watcher) = self.watcher.lock().as_mut() { for path in self.paths.lock().iter() { let _ = watcher.unwatch(path); } }
        self.paths.lock().clear();
    }
    #[cfg(test)]
    pub(super) fn inject_rescan_required(&self) {
        signal_notification(Ok(notify::Event::new(notify::EventKind::Other).set_flag(notify::event::Flag::Rescan)),&self.hint,&self.failed);
    }
    pub fn stop(&mut self) { self.stop.store(true, Ordering::Release); self.watcher.lock().take(); if let Some(thread) = self.thread.take() { let _ = thread.join(); } }
}
impl Drop for ProjectWatcher { fn drop(&mut self) { self.stop(); } }
