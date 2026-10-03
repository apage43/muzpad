mod analysis;
pub mod exports;
mod inspection;
pub mod sources;

use crate::protocol::{self, Context, Failure, PrivateRequest, ProjectRef};
use muz::{compile::Compiled, native::*};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{collections::{BTreeMap, HashMap, VecDeque}, fs::File, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc::{self, Receiver, SyncSender}}, time::{Duration, Instant}};

pub struct Accepted {
    pub compiled: Compiled,
    pub reference: Value,
    pub assets: Arc<sources::PinnedAssets>,
    runtime_revision: u64,
}
type Tokens=Arc<Mutex<HashMap<String,Arc<AtomicBool>>>>;
type EarlyCancels=Arc<Mutex<VecDeque<(String,Instant)>>>;
struct Telemetry { status:Option<Value>, analysis:Option<Value>, dropped:u64 }
struct Output { reliable:SyncSender<Value>, telemetry:Arc<Mutex<Telemetry>>, sequence:u64 }
impl Output {
    fn reply(&self,context:&Context,result:Result<Value,Failure>)->anyhow::Result<()> {
        let frame=protocol::reply(context,result);
        protocol::send_frames(frame,|frame|self.reliable.send(frame)
            .map_err(|_|Failure::new("child_died","engine","Private output closed")))?;
        Ok(())
    }
    fn event(&mut self,context:&Context,scope:&str,value:Value)->anyhow::Result<()> {
        self.sequence=self.sequence.checked_add(1).ok_or_else(||anyhow::anyhow!("Event identity overflow"))?;
        let mut frame=protocol::event(context,self.sequence,scope,value);
        if serde_json::to_vec(&frame)?.len()>protocol::FRAME_BYTES {
            let failure=Failure::new("too_large","engine","Event exceeds negotiated frame budget");
            frame=protocol::event(context,self.sequence,"runtime",json!({"kind":"failure","failure":failure}));
        }
        self.reliable.send(frame).map_err(|_|anyhow::anyhow!("Private output closed"))
    }
    fn telemetry(&mut self,context:&Context,value:Value)->anyhow::Result<()> {
        let reference=if value["kind"]=="analysis"{&value["frame"]["ref"]}else{&value["status"]["ref"]};
        anyhow::ensure!(reference["engineEpoch"].as_str()==context.engine_epoch.as_deref()
            &&context.project.as_ref().is_some_and(|project|reference["project"].as_str()==Some(project.project.as_str())
                &&reference["epoch"].as_str()==Some(project.epoch.as_str()))
            &&reference["sourceVersion"].as_u64().is_some_and(|version|version<=protocol::MAX_SAFE_INTEGER)
            &&reference["revision"].as_str().is_some_and(|revision|!revision.is_empty()&&revision.len()<=128),
            "Telemetry reference does not match the engine project");
        let source_version=reference["sourceVersion"].clone();let revision=reference["revision"].clone();
        let limit=if value["kind"]=="analysis"{128*1024}else{protocol::FRAME_BYTES-4096};
        if serde_json::to_vec(&value)?.len()>limit{
            return self.event(context,"runtime",json!({"kind":"failure","failure":Failure::new("too_large","engine","Telemetry exceeds negotiated payload budget")}));
        }
        self.sequence=self.sequence.checked_add(1).ok_or_else(||anyhow::anyhow!("Event identity overflow"))?;
        let mut frame=protocol::event(context,self.sequence,"runtime",value);
        frame["sourceVersion"]=source_version;frame["revision"]=revision;
        let mut pending=self.telemetry.lock();
        if frame["event"]["value"]["kind"]=="analysis" {
            if pending.analysis.is_some(){pending.dropped=pending.dropped.saturating_add(1);}
            let core=frame["event"]["value"]["frame"]["dropped"].as_str().and_then(|v|v.parse::<u64>().ok()).unwrap_or(0);
            frame["event"]["value"]["frame"]["dropped"]=json!(core.saturating_add(pending.dropped).to_string());
            pending.analysis=Some(frame);
        } else {pending.status=Some(frame);}
        Ok(())
    }
}
enum Input { Request(PrivateRequest), Closed }
enum SourceJob {
    Build { request:PrivateRequest,snapshot:Arc<sources::Snapshot>,cancel:Arc<AtomicBool> },
    Format { request:PrivateRequest,cancel:Arc<AtomicBool> },
    Entries { request:PrivateRequest,snapshot:Arc<sources::Snapshot>,cancel:Arc<AtomicBool> },
}
enum SourceResult {
    Build { id:String,result:Result<(Compiled,Arc<sources::PinnedAssets>),Failure> },
    Reply { context:Context,result:Result<Value,Failure> },
    Progress { context:Context,snapshot:String,done:usize,total:usize },
}
struct SourceWorker { sender:Option<SyncSender<SourceJob>>, receiver:Receiver<SourceResult>, thread:Option<std::thread::JoinHandle<()>> }
impl SourceWorker {
    fn new()->Self {
        let (sender,jobs)=mpsc::sync_channel::<SourceJob>(64);let (results,receiver)=mpsc::channel();
        let thread=std::thread::spawn(move||while let Ok(job)=jobs.recv(){match job {
            SourceJob::Build {request,snapshot,cancel}=>{let result=sources::compile(&snapshot,&snapshot.entry,cancel);if results.send(SourceResult::Build{id:request.context.request_id,result}).is_err(){break;}},
            SourceJob::Format {request,cancel}=>{
                let result=(||{let source=string(&request.args,"source")?;if source.len()>protocol::SOURCE_DOCUMENT_BYTES{return Err(Failure::new("too_large","compile","Source document too large"));}
                    let buffer_version=request.args["bufferVersion"].as_u64().filter(|v|*v<=protocol::MAX_SAFE_INTEGER).ok_or_else(||invalid("Invalid formatter bufferVersion"))?;
                    let path=string(&request.args,"path")?;
                    if cancel.load(Ordering::Relaxed){return Err(cancelled("compile"));}
                    let formatted=muz::lang::format::format(source).map_err(|error|sources::core_failure(muz::lang::syntax(std::path::Path::new(path),source,error),"compile",&cancel))?;
                    if cancel.load(Ordering::Relaxed){return Err(cancelled("compile"));}
                    Ok(json!({"bufferVersion":buffer_version,"source":formatted}))})();
                if results.send(SourceResult::Reply{context:request.context,result}).is_err(){break;}
            },
            SourceJob::Entries {request,snapshot,cancel}=>{
                let result=(||{
                    let entries=request.args["entries"].as_array().ok_or_else(||invalid("Missing ordered entries"))?;
                    if entries.len()>1000{return Err(Failure::new("resource_budget","compile","Entry candidate budget exceeded"));}
                    let mut checked=Vec::with_capacity(entries.len());
                    for (index,entry) in entries.iter().enumerate(){
                        if cancel.load(Ordering::Relaxed){return Err(cancelled("compile"));}
                        let entry=entry.as_str().ok_or_else(||invalid("Entry must be a source path"))?;
                        let result=snapshot.path(entry).and_then(|path|sources::compile(&snapshot,&path,cancel.clone()));
                        checked.push(match result{Ok(_)=>json!({"entry":entry,"playable":true,"failure":null}),Err(failure)=>json!({"entry":entry,"playable":false,"failure":failure})});
                        if results.send(SourceResult::Progress{context:request.context.clone(),snapshot:snapshot.descriptor["id"].as_str().unwrap_or("").to_owned(),done:index+1,total:entries.len()}).is_err(){return Err(cancelled("compile"));}
                    }
                    Ok(json!({"snapshot":snapshot.descriptor["id"],"sourceVersion":snapshot.descriptor["sourceVersion"],"entries":checked}))
                })();
                if results.send(SourceResult::Reply{context:request.context,result}).is_err(){break;}
            }
        }});
        Self{sender:Some(sender),receiver,thread:Some(thread)}
    }
    fn submit(&self,job:SourceJob)->Result<(),Failure>{self.sender.as_ref().unwrap().try_send(job).map_err(|_|Failure::new("queue_full","compile","Source operation queue full"))}
    fn shutdown(&mut self){self.sender.take();if let Some(thread)=self.thread.take(){let _=thread.join();}}
}
struct Build {
    request:PrivateRequest,snapshot:Arc<sources::Snapshot>,cancel:Arc<AtomicBool>,candidate:Option<Compiled>,assets:Option<Arc<sources::PinnedAssets>>,
    prepared:Option<PreparedNativeRevision>,ticket:Option<RevisionTicket>,reference:Value,initial:Value,effect:Value,authorized:bool,preparation_reported:bool,
}
#[derive(Default)]
struct Subscription { enabled:bool,source:Option<String> }
struct Control { context:Context,stop_seek:bool,stop_active:bool,void:bool,expected_generation:u64,cancel:Arc<AtomicBool>,subscription:Option<Subscription> }
struct Restart { prepared:Option<PreparedNativeRevision>,ticket:RevisionTicket }
struct Coordinator {
    output:Output,tokens:Tokens,early_cancels:EarlyCancels,epoch:Option<String>,project:Option<ProjectRef>,grants:Option<Arc<sources::Grants>>,
    uploads:BTreeMap<String,sources::Upload>,snapshots:BTreeMap<String,Arc<sources::Snapshot>>,snapshot_order:VecDeque<String>,
    runtime:Option<NativeRuntime>,final_status:Option<NativeStatus>,empty:muz::Session,current:Option<Arc<Accepted>>,previous:Option<Arc<Accepted>>,
    active:Option<Build>,queued:Option<PrivateRequest>,controls:HashMap<u64,Control>,restart:Option<Restart>,restart_requested:Option<PluginRestartRequest>,tail_pause:Option<NativeOperationId>,
    source:SourceWorker,exports:exports::Scheduler,analysis:analysis::Analysis,subscription:Subscription,meters:Value,
    resolved:VecDeque<String>,pending:HashMap<String,Context>,last_status:Instant,stopping:bool,
}
impl Coordinator {
    fn new(output:Output,tokens:Tokens,early_cancels:EarlyCancels)->Self {
        Self{output,tokens,early_cancels,epoch:None,project:None,grants:None,uploads:BTreeMap::new(),snapshots:BTreeMap::new(),snapshot_order:VecDeque::new(),
            runtime:None,final_status:None,empty:empty_session(),current:None,previous:None,active:None,queued:None,controls:HashMap::new(),restart:None,restart_requested:None,tail_pause:None,
            source:SourceWorker::new(),exports:exports::Scheduler::new(),analysis:analysis::Analysis::new(),subscription:Subscription::default(),meters:json!([]),resolved:VecDeque::new(),pending:HashMap::new(),last_status:Instant::now(),stopping:false}
    }
    fn token(&self,id:&str)->Arc<AtomicBool>{
        let early={
            let mut cancelled=self.early_cancels.lock();
            while cancelled.front().is_some_and(|(_,at)|at.elapsed()>Duration::from_secs(60)){cancelled.pop_front();}
            cancelled.iter().any(|(target,_)|target==id)
        };
        let token=self.tokens.lock().entry(id.to_owned()).or_insert_with(||Arc::new(AtomicBool::new(early))).clone();
        if early{token.store(true,Ordering::Relaxed);}token
    }
    fn finish(&mut self,context:&Context,result:Result<Value,Failure>)->anyhow::Result<()> {
        self.pending.remove(&context.request_id);self.tokens.lock().remove(&context.request_id);
        self.resolved.push_back(context.request_id.clone());if self.resolved.len()>128{self.resolved.pop_front();}
        self.output.reply(context,result)
    }
    fn context(&self)->Context {Context::host(self.epoch.clone(),self.project.clone())}
    fn capabilities(&self)->Value {
        let mut value=protocol::capabilities(self.epoch.as_deref().unwrap_or(""));
        if let Some(runtime)=&self.runtime{value["audio"]=json!({"available":true,"reason":null,"configuration":audio_configuration(&runtime.status())});}
        value
    }
    fn admit(&mut self,request:PrivateRequest)->anyhow::Result<()> {
        let context=request.context.clone();
        if let Err(failure)=context.validate(){return self.output.reply(&context,Err(failure));}
        if self.pending.contains_key(&context.request_id)||self.resolved.contains(&context.request_id){return self.output.reply(&context,Err(Failure::new("stale_request","engine","Request identity already used")));}
        if request.command!="hello" && (self.epoch.is_none()||context.engine_epoch!=self.epoch){return self.output.reply(&context,Err(Failure::new("stale_request","engine","Engine epoch does not match")));}
        if !["hello","configureProject","shutdown","cancel","cancelExport"].contains(&request.command.as_str()) && context.project!=self.project {
            return self.output.reply(&context,Err(Failure::new("stale_request","engine","Project epoch does not match")));
        }
        if ["inspect","explain","location","diff","transport","setAudition","setAnalysisSubscription","startExport"].contains(&request.command.as_str()){
            let reference=&request.args["ref"];
            if reference["engineEpoch"].as_str()!=context.engine_epoch.as_deref()
                || reference["revision"].as_str()!=context.revision.as_deref()
                || reference["sourceVersion"].as_u64()!=context.source_version
                || context.project.as_ref().is_none_or(|p|reference["project"]!=p.project||reference["epoch"]!=p.epoch){
                return self.output.reply(&context,Err(Failure::new("stale_request","engine","Reference does not match request identity")));
            }
        }
        if self.pending.len()>=64 && !["cancel","cancelExport","authorizeApply","shutdown"].contains(&request.command.as_str()){
            return self.output.reply(&context,Err(Failure::new("queue_full","engine","Outstanding request budget exceeded")));
        }
        self.pending.insert(context.request_id.clone(),context.clone());
        self.token(&context.request_id);
        let result=self.dispatch(request);
        match result {Ok(Some(value))=>self.finish(&context,Ok(value)),Ok(None)=>Ok(()),Err(failure)=>self.finish(&context,Err(failure))}
    }
    fn dispatch(&mut self,request:PrivateRequest)->Result<Option<Value>,Failure> {
        let args=&request.args;
        match request.command.as_str() {
            "hello"=>{
                if self.epoch.is_some(){return Err(Failure::new("protocol_mismatch","engine","Handshake already completed"));}
                if args["coreRevision"]!=env!("MUZPAD_CORE_REVISION") || args["limits"]!=protocol::limits(){return Err(Failure::new("protocol_mismatch","engine","Core revision or resource limits mismatch"));}
                self.epoch=Some(request.context.engine_epoch.clone().ok_or_else(||invalid("Handshake requires engine epoch"))?);
                Ok(Some(json!({"coreRevision":env!("MUZPAD_CORE_REVISION"),"protocolVersion":protocol::VERSION,"capabilities":self.capabilities()})))
            },
            "configureProject"=>{
                let project:ProjectRef=serde_json::from_value(args["project"].clone()).map_err(|e|invalid(e.to_string()))?;
                let grants=if args["readGrants"].as_array().is_some_and(Vec::is_empty){None}else{Some(sources::Grants::new(args["readGrants"].clone())?)};
                if self.project.as_ref()!=Some(&project){self.retire_project().map_err(engine_failure)?;}
                self.project=Some(project);self.grants=grants;Ok(Some(Value::Null))
            },
            "snapshotBegin"=>{
                let id=string(&args["snapshot"],"id")?.to_owned();
                if self.uploads.contains_key(&id){return Err(invalid("Snapshot identity is already uploading"));}
                if self.snapshots.get(&id).is_some_and(|s|s.descriptor!=args["snapshot"]){return Err(invalid("Snapshot identity cannot change its descriptor"));}
                if self.uploads.len()>=2{return Err(Failure::new("queue_full","compile","Snapshot upload budget exceeded"));}
                let project=self.project.as_ref().ok_or_else(||invalid("No configured project"))?;
                if args["snapshot"]["project"]!=project.project || args["snapshot"]["epoch"]!=project.epoch{return Err(Failure::new("stale_request","compile","Snapshot project mismatch"));}
                self.uploads.insert(id,sources::Upload::begin(args,self.grants.clone().ok_or_else(||invalid("No read grants"))?)?);Ok(Some(Value::Null))
            },
            "snapshotChunk"=>{let id=string(args,"snapshot")?;self.uploads.get_mut(id).ok_or_else(||invalid("Unknown source upload"))?.chunk(args)?;Ok(Some(Value::Null))},
            "snapshotFinish"=>{
                let id=string(args,"snapshot")?.to_owned();let upload=self.uploads.remove(&id).ok_or_else(||invalid("Unknown source upload"))?;
                let snapshot=upload.finish()?;
                if let Some(existing)=self.snapshots.get(&id){
                    if !existing.same_capture(&snapshot){return Err(Failure::new("source_conflict","compile","Snapshot identity cannot change captured text"));}
                    return Ok(Some(Value::Null));
                }
                while self.snapshots.len()>=4 {
                    let old=self.snapshot_order.pop_front().ok_or_else(||Failure::new("resource_budget","compile","Pinned source snapshot budget exceeded"))?;
                    if self.snapshots.get(&old).is_some_and(|s|Arc::strong_count(s)>1){self.snapshot_order.push_back(old);return Err(Failure::new("resource_budget","compile","Source snapshots remain pinned"));}
                    self.snapshots.remove(&old);
                }
                self.snapshots.insert(id.clone(),snapshot);self.snapshot_order.push_back(id);Ok(Some(Value::Null))
            },
            "snapshotDiscard"=>{let id=string(args,"snapshot")?;if self.snapshots.get(id).is_some_and(|s|Arc::strong_count(s)>1){return Err(Failure::new("resource_budget","compile","Snapshot remains pinned"));}self.uploads.remove(id);self.snapshots.remove(id);self.snapshot_order.retain(|s|s!=id);Ok(Some(Value::Null))},
            "format"=>{let cancel=self.token(&request.context.request_id);self.source.submit(SourceJob::Format{request,cancel})?;Ok(None)},
            "checkEntries"=>{
                let snapshot=self.snapshot(string(args,"snapshot")?)?;
                if request.context.source_version!=snapshot.descriptor["sourceVersion"].as_u64(){return Err(Failure::new("stale_request","compile","Entry check source version does not match snapshot"));}
                let cancel=self.token(&request.context.request_id);self.source.submit(SourceJob::Entries{request,snapshot,cancel})?;Ok(None)
            },
            "rebuild"=>{
                self.snapshot(string(args,"snapshot")?)?;
                if self.active.is_some()||self.restart.is_some(){
                    if let Some(old)=self.queued.replace(request.clone()){self.finish(&old.context,Err(cancelled("compile"))).map_err(engine_failure)?;}
                    if let Some(active)=&self.active {if active.ticket.is_none(){active.cancel.store(true,Ordering::Relaxed);}}
                    self.build_event(&request,"queued",None).map_err(engine_failure)?;
                }else{self.start_build(request)?;}
                Ok(None)
            },
            "authorizeApply"=>{
                let target=string(args,"target")?;
                let active=self.active.as_mut().filter(|b|b.request.context.request_id==target).ok_or_else(||Failure::new("stale_request","apply","Prepared request expired"))?;
                if active.prepared.is_none()||active.ticket.is_some(){return Err(Failure::new("stale_request","apply","Request is not awaiting authorization"));}
                if args["allowed"].as_bool()!=Some(true){
                    let failure=serde_json::from_value(args["failure"].clone()).unwrap_or_else(|_|Failure::new("source_conflict","apply","Source authorization denied"));
                    self.reject_build(failure).map_err(engine_failure)?;
                }else{active.authorized=true;}
                Ok(Some(Value::Null))
            },
            "cancel"=>{
                let target=string(args,"target")?;let state=self.cancel(target)?;Ok(Some(json!({"target":target,"state":state})))
            },
            "cancelExport"=>{let job=string(args,"job")?;let state=if self.exports.cancel(job){"requested"}else{"unknown"};Ok(Some(json!({"target":job,"state":state})))},
            "inspect"|"explain"|"location"|"diff"=>{
                let accepted=self.lookup(&args["ref"],false)?;
                let result=match request.command.as_str(){"inspect"=>inspection::inspect(accepted,args),"explain"=>inspection::explain(accepted,args),"location"=>inspection::location(accepted,args),_=>inspection::diff(accepted,self.previous.as_deref().filter(|p|p.reference!=accepted.reference),args)}?;
                Ok(Some(result))
            },
            "transport"|"setAudition"|"setAnalysisSubscription"=>{self.control(request)?;Ok(None)},
            "startExport"=>{
                let accepted=self.lookup(&args["ref"],false)?.clone();
                let output=PathBuf::from(string(args,"outputGrant")?);
                if !output.is_absolute(){return Err(Failure::new("denied_path","export","Output must be an authorized native staging path"));}
                self.exports.submit(accepted,args["spec"].clone(),request.context.clone(),string(args,"job")?.to_owned(),output)?;Ok(None)
            },
            "shutdown"=>{self.stopping=true;Ok(None)},
            _=>Err(Failure::new("protocol_mismatch","engine","Unknown private command")),
        }
    }
    fn snapshot(&self,id:&str)->Result<Arc<sources::Snapshot>,Failure>{self.snapshots.get(id).cloned().ok_or_else(||Failure::new("invalid_source","compile","Unknown or expired source snapshot"))}
    fn lookup(&self,reference:&Value,current_only:bool)->Result<&Arc<Accepted>,Failure>{
        if let Some(current)=&self.current {if current.reference==*reference{return Ok(current);}}
        if !current_only{if let Some(previous)=&self.previous{if previous.reference==*reference{return Ok(previous);}}}
        Err(Failure::new(if current_only{"stale_revision"}else{"expired_revision"},"inspect","Revision is no longer available"))
    }
    fn check_base(&self,request:&PrivateRequest)->Result<(),Failure>{
        let expected=self.current.as_ref().filter(|c|c.reference["project"]==request.context.project.as_ref().map(|p|p.project.as_str()).unwrap_or(""));
        if request.args["base"]!=expected.map_or(Value::Null,|c|c.reference.clone()){return Err(Failure::new("stale_revision","apply","Rebuild base is no longer accepted"));}Ok(())
    }
    fn start_build(&mut self,request:PrivateRequest)->Result<(),Failure>{
        self.check_base(&request)?;let snapshot=self.snapshot(string(&request.args,"snapshot")?)?;
        if request.context.source_version!=snapshot.descriptor["sourceVersion"].as_u64(){return Err(Failure::new("stale_request","compile","Source version does not match snapshot"));}
        let cancel=self.token(&request.context.request_id);
        self.source.submit(SourceJob::Build{request:request.clone(),snapshot:snapshot.clone(),cancel:cancel.clone()})?;
        self.build_event(&request,"compiling",None).map_err(engine_failure)?;
        self.active=Some(Build{request,snapshot,cancel,candidate:None,assets:None,prepared:None,ticket:None,reference:Value::Null,initial:Value::Null,effect:Value::Null,authorized:false,preparation_reported:false});Ok(())
    }
    fn build_event(&mut self,request:&PrivateRequest,phase:&str,failure:Option<&Failure>)->anyhow::Result<()> {
        self.output.event(&request.context,"runtime",json!({"kind":"build","requestId":request.context.request_id,"project":request.context.project,"sourceVersion":request.context.source_version,"phase":phase,"ref":if phase=="accepted"{self.current.as_ref().map(|a|a.reference.clone()).unwrap_or(Value::Null)}else{Value::Null},"failure":failure}))
    }
    fn reject_build(&mut self,mut failure:Failure)->anyhow::Result<()> {
        if self.current.is_none(){failure.continuity="not-started".into();}
        if let Some(build)=self.active.take(){
            build.cancel.store(true,Ordering::Relaxed);
            self.build_event(&build.request,if failure.code=="cancelled"{"cancelled"}else{"rejected"},Some(&failure))?;
            self.finish(&build.request.context,Err(failure))?;
        }Ok(())
    }
    fn compiled(&mut self,id:String,result:Result<(Compiled,Arc<sources::PinnedAssets>),Failure>)->anyhow::Result<()> {
        if !self.active.as_ref().is_some_and(|b|b.request.context.request_id==id){return Ok(());}
        let (mut candidate,assets)=match result{Ok(value)=>value,Err(f)=>return self.reject_build(f)};
        if self.active.as_ref().unwrap().cancel.load(Ordering::Relaxed){return self.reject_build(cancelled("compile"));}
        let request=self.active.as_ref().unwrap().request.clone();
        if let Err(failure)=self.check_base(&request){return self.reject_build(failure);}
        if !self.active.as_ref().unwrap().preparation_reported{
            self.build_event(&request,"preparing",None)?;self.active.as_mut().unwrap().preparation_reported=true;
        }
        let context=sources::context(assets.clone(),self.active.as_ref().unwrap().cancel.clone());
        if self.runtime.is_none(){
            match NativeRuntime::start(&self.empty,&context,false){Ok(runtime)=>self.runtime=Some(runtime),Err(error)=>return self.reject_build(native_failure(error,"prepare"))}
            self.output.event(&self.context(),"runtime",json!({"kind":"engine","state":"ready","engineEpoch":self.epoch,"capabilities":self.capabilities(),"failure":null}))?;
        }
        let runtime=self.runtime.as_mut().unwrap();runtime.plugin_stamp().apply(&mut candidate.session);
        let base=self.current.as_ref().map_or(0,|a|a.runtime_revision);let accepted=self.current.as_ref().map_or(&self.empty,|a|&a.compiled.session);
        let plan=match muz::plan_reconciliation(base,accepted,&candidate.session){Ok(plan)=>plan,Err(error)=>return self.reject_build(Failure::new("invalid_source","prepare",error.to_string()))};
        let effect=json!(muz::audio::transaction::preparation_effect(accepted,&candidate.session,&plan));
        let prepared=match runtime.prepare_revision(accepted,&candidate.session,base,request.context.source_version.unwrap_or(0),&context){
            Ok(p)=>p,
            Err(error)=>{
                if error.code==NativeErrorCode::Busy||error.code==NativeErrorCode::QueueFull{
                    let active=self.active.as_mut().unwrap();active.candidate=Some(candidate);active.assets=Some(assets);return Ok(());
                }
                let mut failure=assets.take_failure().unwrap_or_else(||native_failure(error,"prepare"));failure.phase="prepare".into();
                return self.reject_build(failure);
            }
        };
        let snapshot=&self.active.as_ref().unwrap().snapshot;
        let reference=json!({"project":snapshot.descriptor["project"],"epoch":snapshot.descriptor["epoch"],"engineEpoch":self.epoch,"revision":uuid::Uuid::new_v4().to_string(),"sourceVersion":snapshot.descriptor["sourceVersion"],"entry":snapshot.descriptor["entry"]});
        let accepted_metadata=json!({"ref":reference,"exportTracks":inspection::export_tracks(&candidate),"effect":effect});
        let reserved=serde_json::to_vec(&accepted_metadata)?.len()
            .saturating_add(status_byte_budget(&candidate.session)?)
            .saturating_add(serde_json::to_vec(&self.runtime.as_ref().unwrap().status().audio)?.len())
            .saturating_add(8192);
        if reserved>=protocol::FRAME_BYTES{return self.reject_build(Failure::new("too_large","prepare","Accepted status and track metadata exceed the private frame budget"));}
        let initial=match inspection::initial_pages(&candidate,&reference,protocol::FRAME_BYTES-reserved){Ok(p)=>p,Err(f)=>return self.reject_build(f)};
        assets.freeze();
        let mut dependencies=snapshot.dependencies();dependencies.extend(assets.dependencies());
        if serde_json::to_vec(&dependencies)?.len()>protocol::FRAME_BYTES-4096{
            return self.reject_build(Failure::new("resource_budget","prepare","Dependency manifest exceeds private validation budget"));
        }
        let active=self.active.as_mut().unwrap();active.candidate=Some(candidate);active.assets=Some(assets);active.prepared=Some(prepared);active.reference=reference;active.initial=initial;active.effect=effect;
        self.output.event(&request.context,"internal",json!({"kind":"prepared","requestId":request.context.request_id,"snapshot":request.args["snapshot"],"dependencyVersions":dependencies}))
    }
    fn submit_build(&mut self)->anyhow::Result<()> {
        let Some(active)=&self.active else{return Ok(());};
        if active.ticket.is_some(){return Ok(());}
        if active.cancel.load(Ordering::Relaxed){if active.prepared.is_some(){self.reject_build(cancelled("prepare"))?;}return Ok(());}
        if !active.authorized{return Ok(());}
        if let Err(failure)=self.check_base(&active.request){return self.reject_build(failure);}
        let prepared=self.active.as_mut().unwrap().prepared.take().unwrap();
        match self.runtime.as_mut().unwrap().submit_revision(prepared){
            Ok(ticket)=>{let request=self.active.as_ref().unwrap().request.clone();self.active.as_mut().unwrap().ticket=Some(ticket);self.build_event(&request,"applying",None)?;},
            Err(error)=>{if error.error.code==NativeErrorCode::QueueFull{self.active.as_mut().unwrap().prepared=Some(error.prepared);}else{return self.reject_build(native_failure(error.error,"apply"));}}
        }Ok(())
    }
    fn cancel(&mut self,target:&str)->Result<&'static str,Failure>{
        if self.resolved.iter().any(|s|s==target){return Ok("finished");}
        if !self.pending.contains_key(target){return Ok(if self.exports.cancel(target){"requested"}else{"unknown"});}
        self.token(target).store(true,Ordering::Relaxed);
        if self.queued.as_ref().is_some_and(|q|q.context.request_id==target){let queued=self.queued.take().unwrap();self.finish(&queued.context,Err(cancelled("compile"))).map_err(engine_failure)?;}
        if let Some(active)=&self.active{if active.request.context.request_id==target{if let Some(ticket)=active.ticket{self.runtime.as_mut().unwrap().cancel_operation(ticket.operation).map_err(|e|native_failure(e,"apply"))?;}}}
        let operations:Vec<u64>=self.controls.iter().filter(|(_,c)|c.context.request_id==target).map(|(id,_)|*id).collect();
        for operation in operations{self.runtime.as_mut().unwrap().cancel_operation(NativeOperationId(operation)).map_err(|e|native_failure(e,"transport"))?;}
        self.exports.cancel(target);Ok("requested")
    }
    fn control(&mut self,request:PrivateRequest)->Result<(),Failure>{
        if self.controls.len()>=64{return Err(Failure::new("queue_full","transport","Control outcome budget exceeded"));}
        let accepted=self.lookup(&request.args["ref"],true)?.clone();
        if self.controls.values().any(|c|c.stop_active){return Err(Failure::new("stale_transport","transport","Stop is awaiting its rewind receipt"));}
        let cancel=self.token(&request.context.request_id);if cancel.load(Ordering::Relaxed){return Err(cancelled("transport"));}
        let runtime=self.runtime.as_mut().ok_or_else(||Failure::new("audio_unavailable","transport","Native output is not running"))?;
        let before=runtime.status().transport;let generation=before.generation;let was_running=before.snapshot.running;let revision=accepted.runtime_revision;
        let context=sources::context(accepted.assets.clone(),cancel.clone());
        let mut stop_seek=false;let mut void=false;
        let ticket=match request.command.as_str(){
            "setAudition"=>{void=true;let ids:Vec<String>=serde_json::from_value(request.args["physicalIds"].clone()).map_err(|e|invalid(e.to_string()))?;runtime.set_audibility(revision,&ids)},
            "setAnalysisSubscription"=>{
                void=true;let enabled=request.args["enabled"].as_bool().ok_or_else(||invalid("Missing subscription enabled flag"))?;
                let analysis=if enabled{Some(match request.args["source"].as_str(){Some(id)=>ObservationTarget::Track(id.to_owned()),None=>ObservationTarget::Master})}else{None};
                let tracks=accepted.compiled.session.tracks.iter().map(|t|t.id.to_string()).collect::<Vec<_>>();
                if tracks.len()>1000{return Err(Failure::new("resource_budget","transport","Track meter subscription exceeds 1000 physical tracks"));}
                runtime.set_observation(revision,&ObservationSelection{meter_tracks:tracks,master_meter:true,analysis,meter_hz:20,analysis_hz:if enabled{10}else{0}})
            },
            _=>match string(&request.args["command"],"kind")?{
                "play"=>runtime.set_running(revision,true),"pause"=>runtime.set_running(revision,false),
                "stop"=>{stop_seek=true;runtime.set_running(revision,false)},"panic"=>runtime.panic(revision),
                "restart"=>runtime.restart(&accepted.compiled.session,revision,&context),
                "seek"=>runtime.seek_ticks(&accepted.compiled.session,revision,tick(&request.args["command"]["tick"])? ,&context),
                "loop"=>{let value=&request.args["command"]["range"];let range=if value.is_null(){None}else{let r=value.as_array().filter(|r|r.len()==2).ok_or_else(||invalid("Loop range requires two ticks"))?;Some((tick(&r[0])?,tick(&r[1])?))};runtime.set_loop(&accepted.compiled.session,revision,range,&context)},
                _=>return Err(invalid("Unknown transport command")),
            }
        }.map_err(|e|native_failure(e,"transport"))?;
        let expected_generation=generation.saturating_add(u64::from(stop_seek&&was_running));
        let subscription=(request.command=="setAnalysisSubscription").then(||Subscription{enabled:request.args["enabled"].as_bool().unwrap_or(false),source:request.args["source"].as_str().map(str::to_owned)});
        self.controls.insert(ticket.operation.0,Control{context:request.context,stop_seek,stop_active:stop_seek,void,expected_generation,cancel,subscription});Ok(())
    }
    fn status(&self,transport:Option<NativeTransportStatus>)->Result<Value,Failure>{
        let accepted=self.current.as_ref().ok_or_else(||Failure::new("stale_revision","transport","No accepted revision"))?;
        let status=self.runtime.as_ref().map(NativeRuntime::status).or_else(||self.final_status.clone()).ok_or_else(||Failure::new("audio_unavailable","transport","Native output unavailable"))?;
        let t=transport.unwrap_or(status.transport);let snapshot=t.snapshot;let playing=snapshot.running;
        let ppq=accepted.compiled.session.tracks.iter().find_map(|track|match &track.source{muz::model::TrackSource::Midi(midi)=>Some(midi.summary.ppq as f64),_=>None}).unwrap_or(muz::model::TICKS_PER_BEAT as f64);
        Ok(json!({"ref":accepted.reference,"generation":t.generation.to_string(),"playing":playing,"finished":tail_complete(t,accepted.compiled.session.extras.tail),
            "beat":snapshot.beat_position,"seconds":snapshot.project_frame/snapshot.sample_rate,"bpm":snapshot.bpm,"meter":snapshot.meter,
            "duration":t.end_project_frame/snapshot.sample_rate,"endBeat":t.end_tick as f64/ppq,"tail":accepted.compiled.session.extras.tail,
            "loop":t.loop_range.map(|(start,end)|[start as f64/960000.,end as f64/960000.]),"peak":if playing{status.last_peak}else{0.},"rms":if playing{status.last_rms}else{0.},
            "meters":if playing{self.meters.clone()}else{json!([])},"audio":audio_configuration(&status),
            "health":{"acceptedRevision":status.accepted_revision.to_string(),"runtimeRevision":status.runtime_revision.to_string(),"sourceGeneration":status.source_generation.to_string(),"runtimeMappingPending":status.runtime_mapping_pending,"deliveredEvents":status.delivered_events,"devices":status.devices,"streamStartCount":status.stream_start_count.to_string(),"audio":status.audio,"observationDropped":status.observation_dropped.to_string()}}))
    }
    fn native_event(&mut self,event:NativeEvent)->anyhow::Result<()> {
        match event {
            NativeEvent::RevisionApplied{ticket,transport,plugin_stamp,..}=>{
                if self.active.as_ref().is_some_and(|b|b.ticket==Some(ticket)){
                    let mut build=self.active.take().unwrap();let mut compiled=build.candidate.take().unwrap();plugin_stamp.apply(&mut compiled.session);
                    let accepted=Arc::new(Accepted{compiled,reference:build.reference,assets:build.assets.take().unwrap(),runtime_revision:ticket.revision});
                    self.previous=self.current.replace(accepted);self.meters=json!([]);
                    let value=json!({"ref":self.current.as_ref().unwrap().reference,"status":self.status(Some(transport))?,"effect":build.effect,"initialPages":build.initial,"exportTracks":inspection::export_tracks(&self.current.as_ref().unwrap().compiled)});
                    self.build_event(&build.request,"accepted",None)?;self.finish(&build.request.context,Ok(value))?;
                    self.output.event(&self.context(),"runtime",json!({"kind":"engine","state":"ready","engineEpoch":self.epoch,"capabilities":self.capabilities(),"failure":null}))?;
                    let current=self.current.as_ref().unwrap();let tracks=current.compiled.session.tracks.iter().map(|t|t.id.to_string()).collect::<Vec<_>>();
                    if self.subscription.source.as_ref().is_some_and(|id|!tracks.contains(id)){self.subscription=Subscription::default();self.analysis.clear();}
                    let analysis=if self.subscription.enabled{Some(self.subscription.source.clone().map_or(ObservationTarget::Master,ObservationTarget::Track))}else{None};
                    if let Some(runtime)=self.runtime.as_mut(){
                        if tracks.len()<=1000 {
                            if let Err(error)=runtime.set_observation(ticket.revision,&ObservationSelection{meter_tracks:tracks,master_meter:true,analysis,meter_hz:20,analysis_hz:if self.subscription.enabled{10}else{0}}){
                                self.output.event(&self.context(),"runtime",json!({"kind":"failure","failure":native_failure(error,"transport")}))?;
                            }
                        }else{
                            self.output.event(&self.context(),"runtime",json!({"kind":"failure","failure":Failure::new("resource_budget","transport","Track metering requires a selection within the 1000-track limit")}))?;
                        }
                    }
                }else if self.restart.as_ref().is_some_and(|r|r.ticket==ticket){
                    self.restart.take();if let Some(current)=self.current.as_mut(){
                        let accepted=Arc::get_mut(current).ok_or_else(||anyhow::anyhow!("Accepted compilation has unexpected shared mutable plugin baseline"))?;
                        plugin_stamp.apply(&mut accepted.compiled.session);accepted.runtime_revision=ticket.revision;
                    }
                }else{return Err(anyhow::anyhow!("Unowned native revision receipt"));}
            },
            NativeEvent::RevisionRejected{ticket,error}=>{
                if self.active.as_ref().is_some_and(|b|b.ticket==Some(ticket)){self.reject_build(native_failure(error,"apply"))?;}
                else if self.restart.as_ref().is_some_and(|r|r.ticket==ticket){self.restart.take();self.output.event(&self.context(),"runtime",json!({"kind":"failure","failure":native_failure(error,"prepare")}))?;}
            },
            NativeEvent::ControlApplied{ticket,transport,..}=>{
                if self.tail_pause==Some(ticket.operation){self.tail_pause=None;}
                if let Some(mut control)=self.controls.remove(&ticket.operation.0){
                    if control.stop_seek{
                        control.stop_seek=false;
                        if control.cancel.load(Ordering::Relaxed)||self.runtime.is_none(){self.finish(&control.context,Err(Failure::new("cancelled","transport","Stop paused playback but was cancelled before rewind")))?;}
                        else if let Some(accepted)=&self.current{
                            if accepted.runtime_revision!=ticket.expected_revision || transport.generation!=control.expected_generation {self.finish(&control.context,Err(Failure::new("stale_transport","transport","Transport changed while stopping")))?;}
                            else{
                                let context=sources::context(accepted.assets.clone(),control.cancel.clone());
                                match self.runtime.as_mut().unwrap().seek_ticks(&accepted.compiled.session,ticket.expected_revision,0,&context){
                                    Ok(next)=>{self.controls.insert(next.operation.0,control);},Err(error)=>self.finish(&control.context,Err(native_failure(error,"transport")))?,
                                }
                            }
                        }
                    }else{
                        if let Some(subscription)=control.subscription.take(){self.subscription=subscription;self.analysis.clear();self.output.telemetry.lock().analysis=None;}
                        self.finish(&control.context,if control.void{Ok(Value::Null)}else{self.status(Some(transport))})?;
                    }
                }
            },
            NativeEvent::ControlRejected{ticket,error,..}=>{
                if self.tail_pause==Some(ticket.operation){self.tail_pause=None;}
                if let Some(control)=self.controls.remove(&ticket.operation.0){self.finish(&control.context,Err(native_failure(error,"transport")))?;}
            },
            NativeEvent::PluginRestartRequested(request)=>self.restart_requested=Some(request),
            NativeEvent::OutputFault(error)=>{
                let failure=native_failure(error,"engine").lost();
                let mut capabilities=self.capabilities();capabilities["audio"]["available"]=json!(false);capabilities["audio"]["reason"]=json!(failure.message);
                self.output.event(&self.context(),"runtime",json!({"kind":"engine","state":"failed","engineEpoch":self.epoch,"capabilities":capabilities,"failure":failure}))?;
                self.stopping=true;
            },
        }Ok(())
    }
    fn plugin_service(&mut self)->anyhow::Result<()> {
        if let (Some(runtime),Some(current))=(&mut self.runtime,&self.current){
            if let Err(error)=runtime.service_plugins(&current.compiled.session,current.runtime_revision){
                if error.code!=NativeErrorCode::Busy{self.output.event(&self.context(),"runtime",json!({"kind":"failure","failure":native_failure(error,"engine")}))?;}
            }
        }
        if self.active.is_none()&&self.restart.is_none(){
            if let (Some(request),Some(current),Some(runtime))=(self.restart_requested.take(),self.current.as_ref(),self.runtime.as_mut()){
                if request.expected_revision==current.runtime_revision{
                    let context=sources::context(current.assets.clone(),Arc::new(AtomicBool::new(false)));
                    match runtime.prepare_plugin_restart(&current.compiled.session,current.runtime_revision,current.reference["sourceVersion"].as_u64().unwrap_or(0),&request,&context){
                        Ok(prepared)=>{let ticket=prepared.ticket();self.restart=Some(Restart{prepared:Some(prepared),ticket});},
                        Err(error)=>self.output.event(&self.context(),"runtime",json!({"kind":"failure","failure":native_failure(error,"prepare")}))?,
                    }
                }
            }
        }
        if let Some(restart)=&mut self.restart{if let Some(prepared)=restart.prepared.take(){
            match self.runtime.as_mut().unwrap().submit_revision(prepared){Ok(_)=>{},Err(error)=>{
                if error.error.code==NativeErrorCode::QueueFull{restart.prepared=Some(error.prepared);}else{self.restart.take();self.output.event(&self.context(),"runtime",json!({"kind":"failure","failure":native_failure(error.error,"apply")}))?;}
            }}
        }}Ok(())
    }
    fn export_event(&mut self,event:exports::ExportEvent)->anyhow::Result<()> {
        match event {
            exports::ExportEvent::Progress{context,job,reference,phase,progress}=>self.output.event(&context,"runtime",json!({"kind":"exportProgress","requestId":context.request_id,"job":job,"ref":reference,"phase":phase,"progress":progress})),
            exports::ExportEvent::Finished{context,result,..}=>self.finish(&context,result),
        }
    }
    fn service(&mut self)->anyhow::Result<()> {
        if let Some(runtime)=&mut self.runtime{let mut events:[Option<NativeEvent>;64]=std::array::from_fn(|_|None);runtime.poll(&mut events);for event in events.into_iter().flatten(){self.native_event(event)?;}}
        loop{
            let result=match self.source.receiver.try_recv(){
                Ok(result)=>result,Err(mpsc::TryRecvError::Empty)=>break,
                Err(mpsc::TryRecvError::Disconnected)=>return Err(anyhow::anyhow!("Source compiler thread exited unexpectedly")),
            };
            match result{
            SourceResult::Build{id,result}=>self.compiled(id,result)?,
            SourceResult::Reply{context,result}=>{
                if self.pending.contains_key(&context.request_id){self.finish(&context,if self.token(&context.request_id).load(Ordering::Relaxed){Err(cancelled("compile"))}else{result})?;}
            },
            SourceResult::Progress{context,snapshot,done,total}=>self.output.event(&context,"runtime",json!({"kind":"entries","requestId":context.request_id,"snapshot":snapshot,"done":done,"total":total}))?,
        }}
        if self.active.as_ref().is_some_and(|b|b.candidate.is_some()&&b.prepared.is_none()&&b.ticket.is_none()){
            let active=self.active.as_mut().unwrap();let id=active.request.context.request_id.clone();
            let candidate=active.candidate.take().unwrap();let assets=active.assets.take().unwrap();
            self.compiled(id,Ok((candidate,assets)))?;
        }
        self.submit_build()?;self.plugin_service()?;
        if self.active.is_none()&&self.restart.is_none(){if let Some(request)=self.queued.take(){let context=request.context.clone();if let Err(failure)=self.start_build(request){self.finish(&context,Err(failure))?;}}}
        for event in self.exports.poll(){self.export_event(event)?;}
        if let (Some(runtime),Some(current))=(&mut self.runtime,&self.current){
            let transport=runtime.status().transport;
            if self.tail_pause.is_none()&&self.controls.is_empty()&&self.active.is_none()&&self.restart.is_none()
                &&transport.snapshot.running&&tail_complete(transport,current.compiled.session.extras.tail){
                if let Ok(ticket)=runtime.set_running(current.runtime_revision,false){self.tail_pause=Some(ticket.operation);}
            }
            let mut frames:[Option<ObservationFrame>;4]=std::array::from_fn(|_|None);runtime.drain_observations(&mut frames);
            for frame in frames.into_iter().flatten(){if frame.revision==current.runtime_revision{
                self.meters=json!(frame.tracks.iter().map(|m|json!({"track":m.id,"peak":if frame.running{m.peak}else{0.},"rms":if frame.running{m.rms}else{0.}})).collect::<Vec<_>>());
                if !frame.mono_samples.is_empty(){self.analysis.submit(current.reference.clone(),frame);}
            }}
        }
        while let Some(frame)=self.analysis.poll(){
            if self.subscription.enabled && self.current.as_ref().is_some_and(|a|a.reference==frame["ref"])
                && frame["source"].as_str()==self.subscription.source.as_deref()
                && self.runtime.as_ref().is_some_and(|r|frame["generation"]==r.status().transport.generation.to_string()){
                self.output.telemetry(&self.context(),json!({"kind":"analysis","frame":frame}))?;
            }
        }
        if self.current.is_some()&&self.last_status.elapsed()>=Duration::from_millis(50){self.last_status=Instant::now();let status=self.status(None)?;self.output.telemetry(&self.context(),json!({"kind":"status","status":status}))?;}
        Ok(())
    }
    fn retire_project(&mut self)->anyhow::Result<()>{
        let old=self.project.clone();
        for context in self.pending.values().filter(|c|c.project==old){self.token(&context.request_id).store(true,Ordering::Relaxed);}
        for event in self.exports.shutdown(){self.export_event(event)?;}self.exports=exports::Scheduler::new();
        if let Some(active)=&self.active{active.cancel.store(true,Ordering::Relaxed);}
        if let Some(runtime)=self.runtime.take(){
            let report=runtime.shutdown();self.final_status=Some(report.status);
            for event in report.events{self.native_event(event)?;}
            if let Some(error)=report.error{self.output.event(&self.context(),"runtime",json!({"kind":"failure","failure":native_failure(error,"engine")}))?;}
        }
        if self.active.is_some(){self.reject_build(cancelled("compile"))?;}
        self.restart=None;self.restart_requested=None;self.queued=None;self.controls.clear();
        let pending:Vec<_>=self.pending.values().filter(|c|c.project==old).cloned().collect();
        for context in pending{self.finish(&context,Err(cancelled("engine")))?;}
        self.current=None;self.previous=None;self.final_status=None;self.meters=json!([]);self.subscription=Subscription::default();self.analysis.clear();
        self.tail_pause=None;
        self.uploads.clear();self.snapshots.clear();self.snapshot_order.clear();
        let mut telemetry=self.output.telemetry.lock();telemetry.status=None;telemetry.analysis=None;
        Ok(())
    }
    fn shutdown(&mut self)->anyhow::Result<()> {
        for token in self.tokens.lock().values(){token.store(true,Ordering::Relaxed);}
        for event in self.exports.shutdown(){self.export_event(event)?;}
        self.source.shutdown();
        if let Some(runtime)=self.runtime.take(){
            let report=runtime.shutdown();self.final_status=Some(report.status);
            for event in report.events{self.native_event(event)?;}
            if let Some(error)=report.error{self.output.event(&self.context(),"runtime",json!({"kind":"failure","failure":native_failure(error,"engine")}))?;}
        }
        self.active.take();self.restart.take();self.queued.take();self.controls.clear();self.analysis.shutdown();
        let pending:Vec<Context>=self.pending.values().cloned().collect();
        for context in pending{self.finish(&context,Err(cancelled("engine")))?;}
        self.output.event(&self.context(),"runtime",json!({"kind":"engine","state":"stopped","engineEpoch":self.epoch,"capabilities":self.capabilities(),"failure":null}))
    }
}

pub fn run(mut reader:File,mut writer:File)->anyhow::Result<()> {
    let tokens:Tokens=Arc::new(Mutex::new(HashMap::new()));let receive_tokens=tokens.clone();
    let early_cancels:EarlyCancels=Arc::new(Mutex::new(VecDeque::new()));let receive_cancels=early_cancels.clone();
    let (input_sender,input)=mpsc::sync_channel(64);
    std::thread::spawn(move||{
        let mut transfers=protocol::FrameTransfers::default();
        while let Ok(Some(value))=protocol::read_frame(&mut reader){
            let value=match transfers.receive(value){Ok(Some(value))=>value,Ok(None)=>continue,Err(_)=>break};
            let Ok(request)=serde_json::from_value::<PrivateRequest>(value) else{break;};
            if request.command=="cancel"{
                if let Some(target)=request.args["target"].as_str(){
                    let token=receive_tokens.lock().get(target).cloned();
                    if let Some(token)=token{token.store(true,Ordering::Relaxed);}
                    let mut early=receive_cancels.lock();
                    if early.len()==128{early.pop_front();}
                    early.push_back((target.to_owned(),Instant::now()));
                }
            }
            else if receive_tokens.lock().len()<68{receive_tokens.lock().entry(request.context.request_id.clone()).or_insert_with(||Arc::new(AtomicBool::new(false)));}
            if input_sender.send(Input::Request(request)).is_err(){return;}
        }
        let _=input_sender.send(Input::Closed);
    });
    let (reliable,frames)=mpsc::sync_channel::<Value>(128);let telemetry=Arc::new(Mutex::new(Telemetry{status:None,analysis:None,dropped:0}));let writer_telemetry=telemetry.clone();
    fn write_ordered(writer:&mut File,sequence:&mut u64,mut frame:Value)->std::io::Result<()>{
        if frame.get("event").is_some(){
            *sequence=sequence.checked_add(1).ok_or_else(||std::io::Error::other("Event sequence exhausted"))?;
            frame["sequence"]=json!(sequence.to_string());
        }
        protocol::write_frame(writer,&frame)
    }
    let writer_thread=std::thread::spawn(move||->std::io::Result<()>{
        let mut sequence=0u64;
        loop{match frames.recv_timeout(Duration::from_millis(5)){Ok(frame)=>write_ordered(&mut writer,&mut sequence,frame)?,Err(mpsc::RecvTimeoutError::Disconnected)=>break,Err(mpsc::RecvTimeoutError::Timeout)=>{}}
            let (status,analysis)={let mut t=writer_telemetry.lock();(t.status.take(),t.analysis.take())};
            if let Some(frame)=status{write_ordered(&mut writer,&mut sequence,frame)?;}if let Some(frame)=analysis{write_ordered(&mut writer,&mut sequence,frame)?;}
        }Ok(())
    });
    let output=Output{reliable,telemetry,sequence:0};let mut coordinator=Coordinator::new(output,tokens,early_cancels);
    let mut shutdown_request=None;
    let result=(||->anyhow::Result<()>{
        while !coordinator.stopping{
            coordinator.service()?;
            match input.recv_timeout(Duration::from_millis(3)){
                Ok(Input::Request(request))=>{if request.command=="shutdown"{shutdown_request=Some(request.context.clone());}coordinator.admit(request)?;},
                Ok(Input::Closed)|Err(mpsc::RecvTimeoutError::Disconnected)=>break,Err(mpsc::RecvTimeoutError::Timeout)=>{},
            }
        }Ok(())
    })();
    if let Some(context)=&shutdown_request{coordinator.pending.remove(&context.request_id);}
    let shutdown=coordinator.shutdown();
    if let Some(context)=shutdown_request{coordinator.output.reply(&context,shutdown.as_ref().map(|_|Value::Null).map_err(|e|Failure::new("output_fault","engine",e.to_string())))?;}
    drop(coordinator);
    let writer_result=writer_thread.join().map_err(|_|anyhow::anyhow!("Private writer panicked"))?;
    result?;shutdown?;writer_result?;Ok(())
}
fn empty_session()->muz::Session {
    muz::Session{extras:Default::default(),transport:muz::model::Transport::OneShot{meter:[4,4],meter_source:muz::model::MeterSource::Declared},
        master:muz::model::Bus{id:muz::model::Id::new("master"),name:"Master".into(),inserts:vec![],output:None,sends:vec![]},buses:vec![],tracks:vec![]}
}
fn tail_complete(transport:NativeTransportStatus,tail:f64)->bool{
    transport.loop_range.is_none()&&transport.snapshot.ended
        &&transport.snapshot.project_frame>=transport.end_project_frame+tail*transport.snapshot.sample_rate
}
fn status_byte_budget(session:&muz::Session)->Result<usize,serde_json::Error>{
    fn device_bytes(device:&muz::model::Device)->Result<usize,serde_json::Error>{
        let value=json!({"restart_flags":u32::MAX,"id":device.id,"kind":device.kind,"instance_token":u64::MAX,
            "process_count":u64::MAX,"gain_reduction_db":f32::MIN,"latency_samples":u32::MAX,"tail_samples":u32::MAX,
            "is_plugin":true,"plugin":device.vst3});
        let mut bytes=serde_json::to_vec(&value)?.len()+64;
        if let Some(rack)=&device.rack{for child in rack.branches.iter().flatten(){bytes=bytes.saturating_add(device_bytes(child)?);}}
        Ok(bytes)
    }
    let mut bytes=8192usize;
    for value in session.tracks.iter().flat_map(|t|std::iter::once(&t.instrument).chain(&t.inserts))
        .chain(session.buses.iter().flat_map(|b|&b.inserts)).chain(&session.master.inserts){bytes=bytes.saturating_add(device_bytes(value)?);}
    Ok(bytes)
}
fn audio_configuration(status:&NativeStatus)->Value{json!({"backend":status.audio.host,"device":status.audio.device,"sampleRate":status.audio.rate,"channels":status.audio.channels,"requestedPeriodFrames":status.audio.requested_period,"periodFrames":status.audio.negotiated_period})}
fn invalid(message:impl Into<String>)->Failure{Failure::new("invalid_source","engine",message)}
fn cancelled(phase:&str)->Failure{Failure::new("cancelled",phase,"Operation was cancelled")}
fn engine_failure(error:anyhow::Error)->Failure{Failure::new("child_died","engine",error.to_string())}
fn string<'a>(value:&'a Value,key:&str)->Result<&'a str,Failure>{value[key].as_str().ok_or_else(||invalid(format!("Missing string field {key}")))}
fn tick(value:&Value)->Result<u64,Failure>{let text=value.as_str().ok_or_else(||invalid("Tick must be an unsigned decimal string"))?;if text.is_empty()||(text.len()>1&&text.starts_with('0'))||!text.bytes().all(|c|c.is_ascii_digit()){return Err(invalid("Tick must be a canonical unsigned decimal string"));}text.parse().map_err(|_|invalid("Tick overflows u64"))}
fn native_failure(error:NativeError,phase:&str)->Failure{
    let code=match error.code{NativeErrorCode::Cancelled|NativeErrorCode::Superseded=>"cancelled",NativeErrorCode::StaleRevision|NativeErrorCode::SessionMismatch=>"stale_revision",NativeErrorCode::Busy|NativeErrorCode::QueueFull=>"queue_full",NativeErrorCode::ResourceLimit|NativeErrorCode::RevisionOverflow=>"resource_budget",NativeErrorCode::AudioUnavailable=>"audio_unavailable",NativeErrorCode::OutputFault=>"output_fault",NativeErrorCode::UnknownOperation=>"stale_request",NativeErrorCode::Shutdown=>"child_died",_=>"invalid_source"};
    sources::diagnostic_failure(Failure::new(code,phase,error.message),error.diagnostic.as_ref())
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn telemetry_envelope_matches_accepted_payload_identity(){
        let (reliable,_)=mpsc::sync_channel(1);
        let pending=Arc::new(Mutex::new(Telemetry{status:None,analysis:None,dropped:0}));
        let mut output=Output{reliable,telemetry:pending.clone(),sequence:0};
        let context=Context::host(Some("engine".into()),Some(ProjectRef{project:"project".into(),epoch:"epoch".into()}));
        let reference=json!({"project":"project","epoch":"epoch","engineEpoch":"engine","sourceVersion":7,"revision":"accepted"});
        output.telemetry(&context,json!({"kind":"status","status":{"ref":reference}})).unwrap();
        output.telemetry(&context,json!({"kind":"analysis","frame":{"ref":reference,"dropped":"0"}})).unwrap();
        let pending=pending.lock();
        for frame in [&pending.status,&pending.analysis]{
            let frame=frame.as_ref().unwrap();
            assert_eq!(frame["sourceVersion"],7);assert_eq!(frame["revision"],"accepted");
            assert_eq!(frame["project"],json!({"project":"project","epoch":"epoch"}));
            assert_eq!(frame["engineEpoch"],"engine");
        }
        drop(pending);
        assert!(output.telemetry(&Context::host(Some("other".into()),context.project),json!({"kind":"status","status":{"ref":reference}})).is_err());
    }
    #[test]
    fn ticks_are_lossless_canonical_unsigned_integers(){
        assert_eq!(tick(&json!("18446744073709551615")).unwrap(),u64::MAX);
        assert_eq!(tick(&json!("0")).unwrap(),0);
        for input in ["","01","-1","+1","1.0","18446744073709551616"]{assert!(tick(&json!(input)).is_err());}
        assert!(tick(&json!(960000)).is_err());
    }
    #[test]
    fn finished_waits_for_tail_and_never_finishes_a_loop(){
        let mut transport=NativeTransportStatus{
            generation:0,loop_range:None,end_tick:960000,end_project_frame:48000.,
            snapshot:muz::audio::TransportSnapshot{sample_rate:48000.,running:true,sample_position:48000,beat_position:1.,
                current_tick:960000.,project_frame:48000.,bpm:60.,meter:[4,4],loop_ticks:0,ended:true},
        };
        assert!(!tail_complete(transport,1.));
        transport.snapshot.project_frame=96000.;
        assert!(tail_complete(transport,1.));
        transport.loop_range=Some((0,960000));
        assert!(!tail_complete(transport,1.));
    }
}
