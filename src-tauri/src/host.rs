use crate::{project::{self,ProjectService},protocol::{self,Context,Failure,ProjectRef},supervisor::Supervisor,transfers::Transfers};
use base64::{Engine,engine::general_purpose::STANDARD};
use parking_lot::Mutex;
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use std::{collections::{HashMap,HashSet},path::{Path,PathBuf},sync::{Arc,Weak,atomic::{AtomicBool,AtomicU64,Ordering}},time::Duration};
use tauri::{AppHandle,Emitter,Manager};

#[derive(Debug,Deserialize)]
#[serde(tag="kind",rename_all="camelCase",deny_unknown_fields)]
pub enum Payload { Inline { value:Value }, Upload { id:String } }
#[derive(Debug,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Request { #[serde(flatten)] pub context:Context,pub method:Method,pub payload:Payload }
#[derive(Clone,Copy,Debug,Deserialize,Serialize)]
pub enum Method {
    #[serde(rename="runtime.rebuild")] Rebuild, #[serde(rename="runtime.format")] Format,
    #[serde(rename="runtime.checkEntries")] CheckEntries, #[serde(rename="runtime.inspect")] Inspect,
    #[serde(rename="runtime.explain")] Explain, #[serde(rename="runtime.location")] Location,
    #[serde(rename="runtime.diff")] Diff, #[serde(rename="runtime.transport")] Transport,
    #[serde(rename="runtime.audition")] Audition, #[serde(rename="runtime.analysis")] Analysis,
    #[serde(rename="runtime.export")] Export, #[serde(rename="runtime.dispose")] RuntimeDispose,
    #[serde(rename="project.chooseFolder")] ChooseFolder, #[serde(rename="project.openRecent")] OpenRecent,
    #[serde(rename="project.listRecent")] ListRecent, #[serde(rename="project.newProject")] NewProject,
    #[serde(rename="project.importProject")] ImportProject, #[serde(rename="project.readLibraryDocument")] ReadLibraryDocument,
    #[serde(rename="project.resolveSourceDocument")] ResolveSourceDocument,
    #[serde(rename="project.trustAndRun")] TrustAndRun,
    #[serde(rename="project.save")] Save, #[serde(rename="project.refresh")] Refresh,
    #[serde(rename="project.resolveConflict")] ResolveConflict, #[serde(rename="project.snapshotSources")] SnapshotSources,
    #[serde(rename="project.persistRecovery")] PersistRecovery, #[serde(rename="project.restoreRecovery")] RestoreRecovery,
    #[serde(rename="project.exportArchive")] ExportArchive, #[serde(rename="project.reveal")] Reveal,
    #[serde(rename="project.prepareClose")] PrepareClose, #[serde(rename="project.close")] Close,
    #[serde(rename="preferences.load")] PreferencesLoad, #[serde(rename="preferences.save")] PreferencesSave,
    #[serde(rename="host.restartEngine")] RestartEngine, #[serde(rename="host.openExternal")] OpenExternal,
    #[serde(rename="host.dispose")] Dispose, #[serde(rename="transfer.read")] TransferRead,
    #[serde(rename="transfer.release")] TransferRelease,
}
impl Method {
    fn name(self)->&'static str{match self{
        Self::Rebuild=>"runtime.rebuild",Self::Format=>"runtime.format",Self::CheckEntries=>"runtime.checkEntries",
        Self::Inspect=>"runtime.inspect",Self::Explain=>"runtime.explain",Self::Location=>"runtime.location",
        Self::Diff=>"runtime.diff",Self::Transport=>"runtime.transport",Self::Audition=>"runtime.audition",
        Self::Analysis=>"runtime.analysis",Self::Export=>"runtime.export",Self::RuntimeDispose=>"runtime.dispose",
        Self::ChooseFolder=>"project.chooseFolder",Self::OpenRecent=>"project.openRecent",Self::ListRecent=>"project.listRecent",
        Self::NewProject=>"project.newProject",Self::ImportProject=>"project.importProject",Self::ReadLibraryDocument=>"project.readLibraryDocument",
        Self::ResolveSourceDocument=>"project.resolveSourceDocument",
        Self::TrustAndRun=>"project.trustAndRun",
        Self::Save=>"project.save",Self::Refresh=>"project.refresh",Self::ResolveConflict=>"project.resolveConflict",
        Self::SnapshotSources=>"project.snapshotSources",Self::PersistRecovery=>"project.persistRecovery",Self::RestoreRecovery=>"project.restoreRecovery",
        Self::ExportArchive=>"project.exportArchive",Self::Reveal=>"project.reveal",Self::PrepareClose=>"project.prepareClose",Self::Close=>"project.close",
        Self::PreferencesLoad=>"preferences.load",Self::PreferencesSave=>"preferences.save",
        Self::RestartEngine=>"host.restartEngine",Self::OpenExternal=>"host.openExternal",Self::Dispose=>"host.dispose",
        Self::TransferRead=>"transfer.read",Self::TransferRelease=>"transfer.release",
    }}
}
struct Active { context:Context,cancelled:Arc<AtomicBool>,snapshot:Option<String>,restarting:bool,forward:Option<Context> }
struct AcceptedTracks { reference:Value, ids:Vec<String> }
struct ParentEvent { context:Context,scope:String,value:Value }
#[derive(Default)]
struct ParentTelemetry { status:Option<ParentEvent>,analysis:Option<ParentEvent>,dropped:u64 }
pub struct Host {
    app:AppHandle, projects:Mutex<ProjectService>, engine:Mutex<Option<Arc<Supervisor>>>,
    engine_start:Mutex<()>, snapshot_upload:Mutex<()>, engine_epoch:Mutex<String>, executable:PathBuf, cache_root:PathBuf, capabilities:Mutex<Value>, transfers:Mutex<Transfers>,
    active:Mutex<HashMap<String,Active>>, exports:Mutex<HashMap<String,String>>, lifecycle:Mutex<()>, accepted:Mutex<Option<AcceptedTracks>>,
    sequence:AtomicU64, disposed:AtomicBool, close_ticket:Mutex<Option<(String,String)>>, weak:Weak<Host>,
    events:std::sync::mpsc::SyncSender<ParentEvent>,telemetry:Arc<Mutex<ParentTelemetry>>,
}
fn bad(message:impl Into<String>)->Failure{Failure::new("stale_request","engine",message)}
fn field<'a>(value:&'a Value,key:&str)->Result<&'a str,Failure>{value.get(key).and_then(Value::as_str).ok_or_else(||bad(format!("Missing string field {key}")))}
impl Host {
    pub fn new(app:AppHandle)->Result<Arc<Self>,Failure>{
        let data=app.path().app_data_dir().map_err(|e|Failure::new("permission_denied","project",e.to_string()))?;
        let config=app.path().app_config_dir().map_err(|e|Failure::new("permission_denied","project",e.to_string()))?;
        let resource=app.path().resource_dir().map_err(|e|Failure::new("permission_denied","project",e.to_string()))?;
        let executable=std::env::current_exe()?.parent().ok_or_else(||bad("Application executable has no parent"))?.join("muzpad-engine");
        let holder:Arc<Mutex<Weak<Host>>>=Arc::new(Mutex::new(Weak::new()));let callback_holder=holder.clone();
        let cache_root=data.join("engine-cache");
        std::fs::create_dir_all(&cache_root)?;
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cache_root,std::fs::Permissions::from_mode(0o700))?;
            // Singleton initialization precedes setup, so these belong to a dead
            // prior shell. Recovery/preferences live outside this private cache.
            for entry in std::fs::read_dir(&cache_root)?{
                let entry=entry?;
                if entry.file_name().to_string_lossy().starts_with("engine-"){
                    if entry.file_type()?.is_dir(){std::fs::remove_dir_all(entry.path())?;}else{std::fs::remove_file(entry.path())?;}
                }
            }
        }
        let service=ProjectService::new(data,config,resource,Arc::new(move|value|{
            if let Some(host)=callback_holder.lock().upgrade(){host.emit_project(value);}
        }))?;
        let (events,receiver)=std::sync::mpsc::sync_channel::<ParentEvent>(128);
        let telemetry=Arc::new(Mutex::new(ParentTelemetry::default()));let writer_telemetry=telemetry.clone();
        let host=Arc::new_cyclic(|weak|Self{app,projects:Mutex::new(service),engine:Mutex::new(None),engine_start:Mutex::new(()),snapshot_upload:Mutex::new(()),engine_epoch:Mutex::new(uuid::Uuid::new_v4().to_string()),executable,cache_root,
            capabilities:Mutex::new(protocol::capabilities("")),transfers:Mutex::new(Transfers::default()),active:Mutex::new(HashMap::new()),
            exports:Mutex::new(HashMap::new()),lifecycle:Mutex::new(()),accepted:Mutex::new(None),sequence:AtomicU64::new(0),disposed:AtomicBool::new(false),close_ticket:Mutex::new(None),weak:weak.clone(),events,telemetry});
        *holder.lock()=Arc::downgrade(&host);
        let weak=Arc::downgrade(&host);
        std::thread::Builder::new().name("muzpad-parent-events".into()).spawn(move||{
            loop {
                let event=match receiver.recv_timeout(Duration::from_millis(3)) {
                    Ok(event)=>Some(event),Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>None,Err(std::sync::mpsc::RecvTimeoutError::Disconnected)=>break,
                };
                let Some(host)=weak.upgrade()else{break;};
                if let Some(event)=event {host.emit_now(event);}
                while let Ok(event)=receiver.try_recv(){host.emit_now(event);}
                let (status,analysis)={let mut pending=writer_telemetry.lock();(pending.status.take(),pending.analysis.take())};
                for event in [status,analysis].into_iter().flatten(){host.emit_now(event);}
            }
        })?;
        Ok(host)
    }
    fn context(&self)->Context {Context::host(Some(self.engine_epoch.lock().clone()),None)}
    fn retain_accepted(&self,value:&Value){
        let ids=value["exportTracks"].as_array().into_iter().flatten().filter_map(|v|v["id"].as_str().map(str::to_owned)).collect();
        let mut accepted=self.accepted.lock();
        if accepted.as_ref().is_some_and(|v|v.reference==value["ref"]){
            *accepted=Some(AcceptedTracks{reference:value["ref"].clone(),ids});
        }
    }
    fn emit(&self,context:&Context,scope:&str,value:Value){
        let event=ParentEvent{context:context.clone(),scope:scope.into(),value};
        let mut pending=self.telemetry.lock();
        if scope=="runtime"&&matches!(event.value["kind"].as_str(),Some("status"|"analysis")) {
            if event.value["kind"]=="analysis" {
                if pending.analysis.is_some(){pending.dropped=pending.dropped.saturating_add(1);}
                let mut event=event;let dropped=event.value["frame"]["dropped"].as_str().and_then(|value|value.parse::<u64>().ok()).unwrap_or(0);
                event.value["frame"]["dropped"]=json!(dropped.saturating_add(pending.dropped).to_string());pending.analysis=Some(event);
            }else{pending.status=Some(event);}
            return;
        }
        let barrier=protocol::event_barrier(scope,&event.value);
        if barrier {pending.status=None;pending.analysis=None;}
        let _=self.events.send(event);
    }
    fn emit_now(&self,event:ParentEvent){
        if event.scope=="runtime"&&matches!(event.value["kind"].as_str(),Some("status"|"analysis")) {
            let reference=if event.value["kind"]=="analysis"{&event.value["frame"]["ref"]}else{&event.value["status"]["ref"]};
            if self.accepted.lock().as_ref().is_none_or(|accepted|accepted.reference!=*reference)||event.context.engine_epoch.as_ref()!=Some(&*self.engine_epoch.lock()){return;}
        }
        let barrier=protocol::event_barrier(&event.scope,&event.value);
        let value=match self.transfers.lock().outgoing(&event.context,event.value){Ok(value)=>value,Err(failure)=>json!({"kind":"failure","failure":failure})};
        let sequence=self.sequence.fetch_add(1,Ordering::Relaxed);
        let mut envelope=protocol::event(&event.context,sequence,&event.scope,value);envelope["barrier"]=json!(barrier);
        let _=self.app.emit_to("main","workbench://event",&envelope);
    }
    fn emit_project(&self,value:Value){
        let mut context=self.context();
        context.project=value.get("snapshot").or_else(||value.get("project")).and_then(project_ref);
        self.emit(&context,"project",value);
    }
    fn child_event(&self,envelope:Value){
        let Ok(mut context)=serde_json::from_value::<Context>(envelope.clone())else{return;};
        if self.engine.lock().as_ref().is_none_or(|e|context.engine_epoch.as_deref()!=Some(e.epoch.as_str())){return;}
        let scope=envelope["event"]["scope"].as_str().unwrap_or("");let value=envelope["event"]["value"].clone();
        if scope=="internal" && value["kind"]=="prepared"{
            let weak=self.weak.clone();std::thread::spawn(move||{
                let Some(host)=weak.upgrade()else{return;};
                let Some(snapshot)=value["snapshot"].as_str()else{return;};let Some(target)=value["requestId"].as_str()else{return;};
                let restarting=host.active.lock().get(target).is_some_and(|request|request.restarting&&request.snapshot.as_deref()==Some(snapshot))
                    ||(value["retained"]==true&&host.accepted.lock().as_ref().is_some_and(|accepted|accepted.reference==value["ref"]));
                let validation={
                    let projects=host.projects.lock();
                    if restarting{projects.validate_retained_snapshot(snapshot,&value["dependencyVersions"])}
                    else{projects.validate_snapshot(snapshot,&value["dependencyVersions"])}
                };
                let Ok(engine)=host.engine_for(&context)else{return;};let mut authorization=context.clone();authorization.request_id=uuid::Uuid::new_v4().to_string();
                let _=engine.request(&authorization,"authorizeApply",json!({"target":target,"authorization":value["authorization"],"allowed":validation.is_ok(),"failure":validation.err()}));
            });return;
        }
        if scope!="runtime"{return;}
        if value["kind"]=="build"&&value["phase"]=="accepted"{
            *self.accepted.lock()=Some(AcceptedTracks{reference:value["ref"].clone(),ids:Vec::new()});
            let snapshot=self.active.lock().get(&context.request_id).and_then(|request|request.snapshot.clone());
            if let Some(snapshot)=snapshot{
                if let Err(failure)=self.projects.lock().retain_accepted_snapshot(&snapshot){self.emit(&context,"runtime",json!({"kind":"failure","failure":failure}));}
            }
        }
        if value["kind"]=="engine"{
            context.project=None;context.source_version=None;context.revision=None;
            if value["capabilities"].is_object(){*self.capabilities.lock()=value["capabilities"].clone();}
            if value["state"]=="failed"||value["state"]=="stopped"{*self.accepted.lock()=None;}
        }
        self.emit(&context,"runtime",value);
    }
    fn start_engine(&self)->Result<Arc<Supervisor>,Failure>{
        let _start=self.engine_start.lock();
        if let Some(engine)=self.engine.lock().as_ref().filter(|e|e.is_alive()).cloned(){return Ok(engine);}
        let weak=self.weak.clone();let engine=Supervisor::spawn(self.executable.clone(),&self.cache_root,Arc::new(move|value|{if let Some(host)=weak.upgrade(){host.child_event(value);}}))?;
        *self.engine.lock()=Some(engine.clone());
        *self.engine_epoch.lock()=engine.epoch.clone();
        let context=Context::host(Some(engine.epoch.clone()),None);
        self.emit(&context,"runtime",json!({"kind":"engine","state":"starting","engineEpoch":engine.epoch,"capabilities":protocol::capabilities(&engine.epoch),"failure":null}));
        let hello=engine.request_timeout(&context,"hello",json!({"coreRevision":env!("MUZPAD_CORE_REVISION"),"limits":protocol::limits()}),Some(Duration::from_secs(10)));
        let value=match hello{Ok(v)=>v,Err(error)=>{engine.shutdown();return Err(error);}};
        if value["protocolVersion"]!=protocol::VERSION || value["coreRevision"]!=env!("MUZPAD_CORE_REVISION"){
            engine.shutdown();return Err(Failure::new("protocol_mismatch","engine","Bundled engine and application revisions differ"));
        }
        *self.capabilities.lock()=value["capabilities"].clone();
        self.emit(&context,"runtime",json!({"kind":"engine","state":"ready","engineEpoch":engine.epoch,"capabilities":value["capabilities"],"failure":null}));Ok(engine)
    }
    pub fn bootstrap(&self)->Result<Value,Failure>{
        let engine=self.start_engine();
        let epoch=self.engine_epoch.lock().clone();
        if let Err(failure)=engine{let context=Context::host(Some(epoch.clone()),None);self.emit(&context,"runtime",json!({"kind":"engine","state":"failed","engineEpoch":epoch,"capabilities":*self.capabilities.lock(),"failure":failure}));}
        let projects=self.projects.lock();let current=projects.current();let recovery=projects.recovery_offers();drop(projects);
        let context=Context::host(Some(epoch.clone()),None);
        let current=match current{Some(snapshot)=>self.transfers.lock().outgoing(&context,snapshot)?,None=>Value::Null};
        Ok(json!({"protocolVersion":protocol::VERSION,"engineEpoch":epoch,"capabilities":*self.capabilities.lock(),"project":current,"recovery":recovery}))
    }
    pub fn validate_context(&self,context:&Context)->Result<(),Failure>{
        context.validate()?;
        if self.disposed.load(Ordering::Acquire){return Err(bad("Host already disposed"));}
        if let Some(epoch)=context.engine_epoch.as_ref(){if &*self.engine_epoch.lock()!=epoch{return Err(bad("Obsolete engine epoch"));}}
        if let Some(project)=context.project.as_ref(){if self.projects.lock().current_ref().as_ref()!=Some(project){return Err(bad("Obsolete project epoch"));}}
        Ok(())
    }
    fn preview_runtime_context(&self,method:Method,context:&Context)->bool {
        if !matches!(method,Method::Transport|Method::Audition|Method::Analysis|Method::Inspect|Method::Explain|Method::Location|Method::Diff|Method::Export){return false;}
        if !self.projects.lock().is_preview(){return false;}
        self.accepted.lock().as_ref().is_some_and(|accepted|{
            let reference=&accepted.reference;context.engine_epoch.as_deref()==reference["engineEpoch"].as_str()
                &&context.revision.as_deref()==reference["revision"].as_str()&&context.source_version==reference["sourceVersion"].as_u64()
                &&context.project.as_ref().is_some_and(|project|reference["project"]==project.project&&reference["epoch"]==project.epoch)
        })
    }
    fn accepted_document(&self,context:&Context,input:&Value,path:&str)->Result<Option<Value>,Failure>{
        let projects=self.projects.lock();
        if input["project"].is_null(){return Ok(None);}
        if project_ref(&input["project"])!=projects.current_ref(){return Err(bad("Readonly document targets an obsolete project"));}
        projects.require_trusted()?;drop(projects);
        let reference=self.accepted.lock().as_ref().map(|accepted|accepted.reference.clone());
        let Some(reference)=reference.filter(|reference|project_ref(reference)==project_ref(&input["project"]))else{return Ok(None);};
        let mut request=context.clone();request.project=project_ref(&reference);request.engine_epoch=reference["engineEpoch"].as_str().map(str::to_owned);
        request.revision=reference["revision"].as_str().map(str::to_owned);request.source_version=reference["sourceVersion"].as_u64();
        let result=self.engine_for(&request)?.request(&request,"sourceDocument",json!({"ref":reference,"path":path}))?;
        Ok((!result.is_null()).then_some(result))
    }
    fn engine_for(&self,context:&Context)->Result<Arc<Supervisor>,Failure>{
        let engine=self.engine.lock().clone().ok_or_else(||Failure::new("child_died","engine","Native engine is not running").lost())?;
        if context.engine_epoch.as_deref()!=Some(engine.epoch.as_str()){return Err(bad("Obsolete engine epoch"));}Ok(engine)
    }
    pub fn request(&self,request:Request)->Value{
        let context=request.context.clone();let result=(||{
            if matches!(request.method,Method::TransferRead|Method::TransferRelease){
                context.validate()?;
                if let Some(epoch)=context.engine_epoch.as_ref(){if &*self.engine_epoch.lock()!=epoch{return Err(bad("Obsolete transfer engine epoch"));}}
            }else if self.preview_runtime_context(request.method,&context){context.validate()?;if self.disposed.load(Ordering::Acquire){return Err(bad("Host already disposed"));}}
            else{self.validate_context(&context)?;}
            let cancelled=Arc::new(AtomicBool::new(false));{
                let mut active=self.active.lock();if active.len()>=64{return Err(Failure::new("queue_full","engine","Outstanding request limit reached"));}
                if active.contains_key(&context.request_id){return Err(bad("Duplicate request identity"));}
                active.insert(context.request_id.clone(),Active{context:context.clone(),cancelled:cancelled.clone(),snapshot:None,restarting:matches!(request.method,Method::RestartEngine),forward:None});
            }
            let result=(||{let value=match request.payload{Payload::Inline{value}=>{
                if serde_json::to_vec(&value).map_err(|e|bad(e.to_string()))?.len()>protocol::FRAME_BYTES-16384{return Err(Failure::new("too_large","project","Use bounded upload for this payload"));}value
            },Payload::Upload{id}=>self.transfers.lock().consume(&context,&id)?};
                if cancelled.load(Ordering::Acquire){return Err(Failure::new("cancelled","engine","Request cancelled before dispatch"));}
                self.dispatch(request.method,&context,value,&cancelled)
            })();
            self.active.lock().remove(&context.request_id);
            if result.is_err()&&matches!(request.method,Method::Close){self.close_ticket.lock().take();}
            let value=result?;
            if matches!(request.method,Method::TransferRead){Ok(value)}else{self.transfers.lock().outgoing(&context,value)}
        })();protocol::reply(&context,result)
    }
    fn snapshot_to_child(&self,engine:&Supervisor,context:&Context,id:&str)->Result<Value,Failure>{
        let _upload=self.snapshot_upload.lock();
        let (snapshot,files,bindings,trusted)={let projects=self.projects.lock();let (bindings,trusted)=projects.snapshot_read_policy(id)?;if !trusted{return Err(Failure::new("trust_required","compile","Imported previews cannot evaluate source code"));}let (snapshot,files)=projects.snapshot_transfer(id)?;(snapshot,files,bindings,trusted)};
        let mut private=context.clone();private.request_id=uuid::Uuid::new_v4().to_string();
        let project=project_ref(&snapshot).ok_or_else(||bad("Snapshot has no project identity"))?;
        private.project=Some(project.clone());private.source_version=snapshot["sourceVersion"].as_u64();
        engine.request(&private,"configureProject",json!({"project":project,"readBindings":bindings,"trustedRead":trusted}))?;
        private.request_id=uuid::Uuid::new_v4().to_string();
        engine.request(&private,"snapshotBegin",json!({"snapshot":snapshot,"files":files.iter().map(|(d,_)|d).collect::<Vec<_>>(),"entry":snapshot["entry"]}))?;
        for (descriptor,text) in &files{for (index,chunk) in text.as_bytes().chunks(protocol::CHUNK_BYTES).enumerate(){
            private.request_id=uuid::Uuid::new_v4().to_string();engine.request(&private,"snapshotChunk",json!({"snapshot":id,"fileId":descriptor["fileId"],"index":index,"data":STANDARD.encode(chunk)}))?;
        }}
        private.request_id=uuid::Uuid::new_v4().to_string();engine.request(&private,"snapshotFinish",json!({"snapshot":id}))?;Ok(snapshot)
    }
    fn dispatch(&self,method:Method,context:&Context,mut value:Value,cancelled:&AtomicBool)->Result<Value,Failure>{
        match method{
            Method::TransferRead=>self.transfers.lock().read(context,field(&value,"id")?,value["index"].as_u64().and_then(|v|usize::try_from(v).ok()).ok_or_else(||bad("Invalid chunk index"))?),
            Method::TransferRelease=>self.transfers.lock().release(context,field(&value,"id")?),
            Method::OpenExternal=>{open_external(field(&value,"url")?)?;Ok(Value::Null)},
            Method::PreferencesLoad|Method::PreferencesSave=>{
                let result=self.projects.lock().dispatch(&method.name(),value,context);
                if let Err(failure)=&result{self.emit(context,"host",json!({"kind":"preferencesFailure","failure":failure}));}
                result
            },
            Method::RestartEngine=>{
                let previous=self.engine.lock().take();
                if let Some(engine)=previous{engine.shutdown();}*self.accepted.lock()=None;
                let engine=self.start_engine()?;let id=self.projects.lock().retained_snapshot();let Some(id)=id else{return Ok(Value::Null);};
                let mut fresh=context.clone();fresh.engine_epoch=Some(engine.epoch.clone());fresh.revision=None;
                let snapshot=self.snapshot_to_child(&engine,&fresh,&id)?;
                fresh.project=project_ref(&snapshot);fresh.source_version=snapshot["sourceVersion"].as_u64();
                if cancelled.load(Ordering::Acquire){return Err(Failure::new("cancelled","compile","Restart rebuild cancelled before compilation"));}
                if let Some(request)=self.active.lock().get_mut(&context.request_id){request.snapshot=Some(id.clone());request.forward=Some(fresh.clone());}
                let result=engine.request(&fresh,"rebuild",json!({"snapshot":id,"base":null}))?;self.retain_accepted(&result);Ok(result)
            },
            Method::Dispose=>{if !self.projects.lock().close_allowed(){return Err(bad("Close permission has not been granted"));}self.shutdown()?;Ok(Value::Null)},
            Method::RuntimeDispose=>{let previous=self.engine.lock().take();if let Some(engine)=previous{engine.shutdown();}*self.accepted.lock()=None;Ok(Value::Null)},
            Method::ReadLibraryDocument|Method::ResolveSourceDocument=>{
                let input=&value["input"];
                let path=if matches!(method,Method::ReadLibraryDocument){field(input,"id")?.strip_prefix("library:").unwrap_or(field(input,"id")?)}else{field(input,"path")?};
                if !self.projects.lock().owns_source_path(path) {
                    if let Some(document)=self.accepted_document(context,input,path)? {
                        let canonical=field(&document,"path")?;let kind=document_kind(canonical);
                        return Ok(if matches!(method,Method::ReadLibraryDocument) {json!({"id":input["id"],"path":canonical,"text":document["text"],"kind":kind})}
                            else {json!({"kind":"library","id":format!("library:{canonical}"),"path":canonical,"text":document["text"],"documentKind":kind})});
                    }
                }
                self.projects.lock().dispatch(method.name(),value,context)
            },
            Method::Rebuild|Method::CheckEntries=>{
                self.projects.lock().require_trusted()?;
                let engine=self.engine_for(context)?;self.snapshot_to_child(&engine,context,field(&value,"snapshot")?)?;
                if matches!(method,Method::Rebuild){if let Some(request)=self.active.lock().get_mut(&context.request_id){request.snapshot=Some(field(&value,"snapshot")?.to_owned());}}
                if cancelled.load(Ordering::Acquire){return Err(Failure::new("cancelled","compile","Build cancelled before compilation"));}
                let result=engine.request(context,if matches!(method,Method::Rebuild){"rebuild"}else{"checkEntries"},value)?;
                if matches!(method,Method::Rebuild){self.retain_accepted(&result);}Ok(result)
            },
            Method::ImportProject|Method::RestoreRecovery=>{
                let _lifecycle=self.lifecycle.lock();
                let staged={let mut projects=self.projects.lock();if matches!(method,Method::ImportProject){projects.stage_import(value["input"].clone())?}else{projects.stage_recovery(&value["input"])?}};
                if !staged{return Ok(Value::Null);}
                let engine=self.engine.lock().clone().filter(|engine|engine.is_alive());
                if let Some(engine)=&engine {
                    if let Err(failure)=engine.request(context,"preparePreview",Value::Null) {
                        self.projects.lock().discard_staged_project();
                        let mut resume=context.clone();resume.request_id=uuid::Uuid::new_v4().to_string();let _=engine.request(&resume,"resumeProject",Value::Null);
                        return Err(failure);
                    }
                }
                if cancelled.load(Ordering::Acquire){
                    self.projects.lock().discard_staged_project();
                    if let Some(engine)=engine {let mut resume=context.clone();resume.request_id=uuid::Uuid::new_v4().to_string();let _=engine.request(&resume,"resumeProject",Value::Null);}
                    return Err(Failure::new("cancelled","project","Project transition cancelled before publication"));
                }
                let result=self.projects.lock().install_staged_project();
                if result.is_err(){if let Some(engine)=engine{let mut resume=context.clone();resume.request_id=uuid::Uuid::new_v4().to_string();let _=engine.request(&resume,"resumeProject",Value::Null);}}
                if result.is_ok()&&self.projects.lock().trusted_read(){self.reset_project_runtime();}
                result
            },
            Method::Format|Method::Inspect|Method::Explain|Method::Location|Method::Diff=>{
                let name=method.name();self.engine_for(context)?.request(context,name.strip_prefix("runtime.").expect("runtime method"),value)
            },
            Method::Transport=>{
                if self.projects.lock().is_preview()&&!matches!(value["command"]["kind"].as_str(),Some("play"|"pause"|"stop"|"panic")){
                    return Err(Failure::new("trust_required","transport","Score-bound transport is disabled while imported content is a preview"));
                }
                let command=value.get_mut("command").ok_or_else(||bad("Missing transport command"))?;
                match command["kind"].as_str(){Some("seek")=>{let tick=beat_ticks(&command["beat"])?;*command=json!({"kind":"seek","tick":tick.to_string()});},
                    Some("loop")=>{if !command["range"].is_null(){let range=command["range"].as_array().filter(|a|a.len()==2).ok_or_else(||bad("Invalid loop range"))?;let a=beat_ticks(&range[0])?;let b=beat_ticks(&range[1])?;if a>=b{return Err(bad("Loop range must be increasing"));}command["range"]=json!([a.to_string(),b.to_string()]);}},
                    Some("play"|"pause"|"stop"|"restart"|"panic")=>(),_=>return Err(bad("Unknown transport command"))}
                self.engine_for(context)?.request(context,"transport",value)
            },
            Method::Audition=>{
                if self.projects.lock().is_preview(){return Err(Failure::new("trust_required","transport","Listening edits are disabled while imported content is a preview"));}
                let ids:Vec<String>={
                    let guard=self.accepted.lock();let accepted=guard.as_ref().ok_or_else(||Failure::new("expired_revision","transport","No accepted native revision"))?;
                    if value["ref"]!=accepted.reference{return Err(Failure::new("stale_revision","transport","Listening request targets a previous revision"));}
                    accepted.ids.clone()
                };
                let muted=string_set(&value["controls"]["muted"])?;let solo=string_set(&value["controls"]["solo"])?;
                if muted.iter().chain(solo.iter()).any(|id|!ids.contains(id)){return Err(Failure::new("invalid_source","transport","Unknown physical listening track"));}
                let physical:Vec<_>=ids.into_iter().filter(|id|!muted.contains(id)&&(solo.is_empty()||solo.contains(id))).collect();
                self.engine_for(context)?.request(context,"setAudition",json!({"ref":value["ref"],"physicalIds":physical}))
            },
            Method::Analysis=>self.engine_for(context)?.request(context,"setAnalysisSubscription",value),
            Method::Export=>self.export(context,value,cancelled),
            Method::PrepareClose=>{
                if !value.get("input").is_some_and(Value::is_object){return Err(bad("Close input must be an object"));}
                let count=self.exports.lock().len();value["_activeExports"]=json!(count);
                if count>0 && value["input"]["cancelExports"]==true{self.cancel_exports()?;value["_activeExports"]=json!(0);}
                let result=self.projects.lock().dispatch(&method.name(),value,context);
                if !result.as_ref().is_ok_and(|v|v["allowed"]==true){self.close_ticket.lock().take();}
                result
            },
            Method::Close=>{
                let _lifecycle=self.lifecycle.lock();
                if !self.exports.lock().is_empty(){return Err(Failure::new("queue_full","export","Active exports must finish or be cancelled before closing"));}
                let previous=self.projects.lock().current_ref();
                let result=self.projects.lock().dispatch(&method.name(),value,context)?;
                if self.projects.lock().close_allowed(){self.shutdown()?;self.app.exit(0);}
                else if self.projects.lock().current_ref()!=previous{self.reset_project_runtime();}
                Ok(result)
            },
            _=>{
                let _lifecycle=self.lifecycle.lock();
                if self.disposed.load(Ordering::Acquire){return Err(bad("Host closed before project operation"));}
                let previous=self.projects.lock().current_ref();
                let result=self.projects.lock().dispatch(&method.name(),value,context)?;
                let (current,trusted)={let projects=self.projects.lock();(projects.current_ref(),projects.trusted_read())};
                if matches!(method,Method::TrustAndRun) {
                    let retained=current.is_none()||self.accepted.lock().as_ref().is_some_and(|accepted|project_ref(&accepted.reference)==current);
                    if retained {if let Some(engine)=self.engine.lock().clone().filter(|engine|engine.is_alive()){let mut resume=context.clone();resume.request_id=uuid::Uuid::new_v4().to_string();resume.engine_epoch=Some(engine.epoch.clone());engine.request(&resume,"resumeProject",Value::Null)?;}}
                    else if trusted {self.reset_project_runtime();}
                }else if current!=previous&&trusted {self.reset_project_runtime();}
                Ok(result)
            },
        }
    }
    fn reset_project_runtime(&self){
        *self.accepted.lock()=None;
        let (project,bindings,trusted)={let service=self.projects.lock();let project=service.current_ref();let bindings=if project.is_some(){service.read_bindings()}else{Vec::new()};(project,bindings,service.trusted_read())};
        let engine=self.engine.lock().clone();
        let Some(engine)=engine.filter(|e|e.is_alive())else{return;};
        // A fresh grantless private identity retires a closed workspace without
        // restarting the process or invalidating the public close reply's epoch.
        let project=project.unwrap_or_else(||ProjectRef{project:uuid::Uuid::new_v4().to_string(),epoch:uuid::Uuid::new_v4().to_string()});
        let context=Context::host(Some(engine.epoch.clone()),Some(project.clone()));
        if let Err(failure)=engine.request_timeout(&context,"configureProject",json!({"project":project,"readBindings":bindings,"trustedRead":trusted}),Some(Duration::from_secs(5))){
            engine.shutdown();self.emit(&context,"runtime",json!({"kind":"failure","failure":failure}));
        }
    }
    fn export(&self,context:&Context,value:Value,cancelled:&AtomicBool)->Result<Value,Failure>{
        let engine=self.engine_for(context)?;
        let midi=value["spec"]["kind"]=="midi";let extension=if midi{"mid"}else{"wav"};
        let destination=rfd::FileDialog::new().set_title("Export accepted revision").set_file_name(format!("muzpad.{extension}")).add_filter(if midi{"MIDI"}else{"Wave audio"},&[extension]).save_file()
            .ok_or_else(||Failure::new("cancelled","export","Export destination selection cancelled"))?;
        if cancelled.load(Ordering::Acquire){return Err(Failure::new("cancelled","export","Export cancelled before rendering"));}
        let staged=project::stage_export(&destination)?;let job=uuid::Uuid::new_v4().to_string();
        {
            let _lifecycle=self.lifecycle.lock();
            if self.disposed.load(Ordering::Acquire){return Err(Failure::new("cancelled","export","Host closed before export admission"));}
            let mut exports=self.exports.lock();
            if exports.len()>=34{return Err(Failure::new("queue_full","export","Export queue is full"));}
            exports.insert(job.clone(),context.request_id.clone());
        }
        let _job=ExportAdmission{jobs:&self.exports,id:job.clone()};
        let result=engine.request(context,"startExport",json!({"ref":value["ref"],"spec":value["spec"],"job":job,"outputGrant":staged.staged_path()}));
        let result=result?;
        if result["job"]!=job||result["ref"]!=value["ref"]||result["clipped"]!=false||result["stagedOutput"].as_str()!=staged.staged_path().to_str(){return Err(Failure::new("protocol_mismatch","export","Native export result does not match the granted job"));}
        if cancelled.load(Ordering::Acquire){return Err(Failure::new("cancelled","export","Export cancelled before publication"));}
        self.emit(context,"runtime",json!({"kind":"exportProgress","requestId":context.request_id,"job":job,"ref":value["ref"],"phase":"publishing","progress":null}));
        staged.publish()?;Ok(json!({"job":job,"ref":value["ref"],"name":destination.file_name().map(|v|v.to_string_lossy()),"clipped":false}))
    }
    pub fn cancel(&self,context:&Context,target:&str)->Result<Value,Failure>{
        context.validate()?;
        let active=self.active.lock();let Some(request)=active.get(target)else{return Ok(json!({"target":target,"state":"unknown"}));};
        if request.context.project!=context.project||request.context.engine_epoch!=context.engine_epoch{return Err(bad("Cancellation context does not own request"));}
        let restarting=request.restarting;
        let mut forward=request.forward.clone().unwrap_or_else(||request.context.clone());
        let cancelled=request.cancelled.clone();drop(active);
        let preview_owned={let projects=self.projects.lock();projects.is_preview()&&projects.preview_project()==context.project&&context.engine_epoch.as_ref()==Some(&*self.engine_epoch.lock())};
        if !restarting&&!preview_owned{self.validate_context(context)?;}
        // Only this registered recovery request may cross its own epoch change;
        // unrelated stale-epoch cancellation remains rejected.
        cancelled.store(true,Ordering::Release);
        if restarting&&forward.engine_epoch!=Some(self.engine_epoch.lock().clone()){forward=self.context();}
        if let Ok(engine)=self.engine_for(&forward){forward.request_id=uuid::Uuid::new_v4().to_string();let _=engine.request(&forward,"cancel",json!({"target":target}));}
        Ok(json!({"target":target,"state":"requested"}))
    }
    fn cancel_exports(&self)->Result<(),Failure>{
        let jobs:Vec<_>=self.exports.lock().iter().map(|(job,request)|(job.clone(),request.clone())).collect();
        let context=self.context();let engine=self.engine_for(&context)?;
        for (job,target) in jobs{
            if let Some(request)=self.active.lock().get(&target){request.cancelled.store(true,Ordering::Release);}
            let mut context=context.clone();context.request_id=uuid::Uuid::new_v4().to_string();
            engine.request(&context,"cancelExport",json!({"job":job}))?;
        }
        if !self.exports.lock().is_empty(){return Err(Failure::new("queue_full","export","Export cancellation is pending; close again after jobs finish"));}Ok(())
    }
    pub fn request_close(&self,reason:&str){
        let weak=self.weak.clone();let reason=reason.to_owned();
        std::thread::spawn(move||{if let Some(host)=weak.upgrade(){host.process_close_request(&reason);}});
    }
    fn process_close_request(&self,reason:&str){
        let _lifecycle=self.lifecycle.lock();
        if self.disposed.load(Ordering::Acquire){return;}
        if self.projects.lock().current_ref().is_none()&&self.exports.lock().is_empty(){
            match self.shutdown(){Ok(())=>self.app.exit(0),Err(failure)=>self.emit_project(json!({"kind":"failure","project":null,"failure":failure}))}
            return;
        }
        let mut pending=self.close_ticket.lock();if pending.is_some(){return;}
        let ticket=uuid::Uuid::new_v4().to_string();*pending=Some((ticket.clone(),reason.into()));
        self.projects.lock().set_close_ticket(ticket.clone());
        self.emit(&self.context(),"host",json!({"kind":"closeRequested","ticket":ticket,"reason":reason}));
    }
    pub fn shutdown(&self)->Result<(),Failure>{
        if self.disposed.swap(true,Ordering::AcqRel){return Ok(());}
        if let Err(error)=self.projects.lock().shutdown(){self.disposed.store(false,Ordering::Release);return Err(error);}
        let previous=self.engine.lock().take();
        if let Some(engine)=previous{engine.shutdown();}Ok(())
    }
    pub fn is_disposed(&self)->bool{self.disposed.load(Ordering::Acquire)}
    pub fn upload_begin(&self,c:Context,purpose:&str,bytes:usize)->Result<Value,Failure>{self.validate_context(&c)?;if purpose!="request"{return Err(bad("Unsupported upload purpose"));}self.transfers.lock().begin(c,bytes)}
    pub fn upload_chunk(&self,c:&Context,id:&str,index:usize,data:&str)->Result<Value,Failure>{self.validate_context(c)?;self.transfers.lock().chunk(c,id,index,data)}
    pub fn upload_finish(&self,c:&Context,id:&str)->Result<Value,Failure>{self.validate_context(c)?;self.transfers.lock().finish(c,id)}
    pub fn upload_discard(&self,c:&Context,id:&str)->Result<Value,Failure>{self.validate_context(c)?;self.transfers.lock().discard(c,id)}
}
fn project_ref(value:&Value)->Option<ProjectRef>{Some(ProjectRef{project:value["project"].as_str()?.into(),epoch:value["epoch"].as_str()?.into()})}
fn string_set(value:&Value)->Result<HashSet<String>,Failure>{let values=value.as_array().ok_or_else(||bad("Invalid physical track selection"))?;let mut out=HashSet::new();for v in values{let id=v.as_str().ok_or_else(||bad("Track IDs must be strings"))?;if !out.insert(id.to_owned()){return Err(bad("Duplicate track ID"));}}Ok(out)}
fn beat_ticks(value:&Value)->Result<u64,Failure>{
    let beat=value.as_f64().filter(|v|v.is_finite()&&*v>=0.).ok_or_else(||bad("Transport beat must be finite and nonnegative"))?;
    let ticks=beat*960_000.;
    if ticks>protocol::MAX_SAFE_INTEGER as f64{return Err(bad("Transport position exceeds exact JavaScript integer range"));}
    // Positions, unlike identities, are quantized to the score's tick resolution.
    Ok(ticks.round() as u64)
}
fn open_external(url:&str)->Result<(),Failure>{let parsed=url::Url::parse(url).map_err(|_|bad("Invalid external URL"))?;if !matches!(parsed.scheme(),"http"|"https")||parsed.host_str().is_none()||!parsed.username().is_empty()||parsed.password().is_some(){return Err(Failure::new("denied_path","project","Only explicit HTTP(S) URLs may open externally"));}
    let mut child=std::process::Command::new("xdg-open").arg(parsed.as_str()).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().map_err(|e|Failure::new("permission_denied","project",format!("Cannot launch system URL opener: {e}")))?;
    std::thread::spawn(move||{let _=child.wait();});Ok(())
}

#[cfg(test)]mod tests{use super::*;#[test]fn position_validation(){assert!(beat_ticks(&json!(-1)).is_err());assert_eq!(beat_ticks(&json!(1.5)).unwrap(),1_440_000);assert!(beat_ticks(&json!(1e100)).is_err());}#[test]fn allowlist_is_closed(){assert!(serde_json::from_str::<Method>("\"shell.execute\"").is_err());}}

struct ExportAdmission<'a>{jobs:&'a Mutex<HashMap<String,String>>,id:String}
impl Drop for ExportAdmission<'_>{fn drop(&mut self){self.jobs.lock().remove(&self.id);}}
fn document_kind(path:&str)->&'static str{match Path::new(path).extension().and_then(|value|value.to_str()).unwrap_or("").to_ascii_lowercase().as_str(){"muz"=>"source","md"|"markdown"=>"document",_=>"text"}}
