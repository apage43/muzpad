mod analysis;
pub mod exports;
mod inspection;
pub mod sources;

use crate::protocol::{self, Context, Failure, PrivateRequest, ProjectRef};
use muz::{compile::Compiled, native::*};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{cell::Cell,collections::{BTreeMap, HashMap, VecDeque}, fs::File, path::{Path,PathBuf}, sync::{Arc, atomic::{AtomicBool,Ordering}, mpsc::{self, Receiver, SyncSender}}, time::{Duration, Instant}};

#[derive(Clone)]
pub struct Accepted {
    pub compiled: Compiled,
    pub reference: Value,
    pub assets: Arc<sources::PinnedAssets>,
    runtime_revision: u64,
    snapshot:String,
    dependencies:Vec<Value>,
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
        if frame["barrier"]==true {let mut telemetry=self.telemetry.lock();telemetry.status=None;telemetry.analysis=None;}
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
    Progress { context:Context,snapshot:String,done:usize,total:usize,current_entry:String,result:Value },
}
struct SourceWorker { sender:Option<SyncSender<SourceJob>>, entries:Arc<Mutex<Option<SourceJob>>>, receiver:Receiver<SourceResult>, thread:Option<std::thread::JoinHandle<()>> }
impl SourceWorker {
    fn new()->Self {
        let (sender,jobs)=mpsc::sync_channel::<SourceJob>(64);let (results,receiver)=mpsc::sync_channel(64);
        let entries=Arc::new(Mutex::new(None));let latest=entries.clone();
        let thread=std::thread::spawn(move||loop {
            let job=match jobs.recv_timeout(Duration::from_millis(3)){
                Ok(job)=>job,Err(mpsc::RecvTimeoutError::Timeout)=>{let Some(job)=latest.lock().take()else{continue;};job},
                Err(mpsc::RecvTimeoutError::Disconnected)=>break,
            };
            match job {
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
                        let path=snapshot.path(entry)?;
                        let mut result=sources::classify(&snapshot,&path,cancel.clone())?;
                        result["entry"]=json!(entry);
                        let progress=SourceResult::Progress{context:request.context.clone(),snapshot:snapshot.descriptor["id"].as_str().unwrap_or("").to_owned(),done:index+1,total:entries.len(),current_entry:entry.to_owned(),result:result.clone()};
                        checked.push(result);
                        let _=results.try_send(progress);
                    }
                    if cancel.load(Ordering::Relaxed){return Err(cancelled("compile"));}
                    Ok(json!({"snapshot":snapshot.descriptor["id"],"sourceVersion":snapshot.descriptor["sourceVersion"],"entries":checked}))
                })();
                if results.send(SourceResult::Reply{context:request.context,result}).is_err(){break;}
            }
        }});
        Self{sender:Some(sender),entries,receiver,thread:Some(thread)}
    }
    fn submit(&self,job:SourceJob)->Result<(),Failure>{
        if matches!(job,SourceJob::Entries{..}) {
            if let Some(SourceJob::Entries{cancel,..})=self.entries.lock().replace(job){cancel.store(true,Ordering::Relaxed);}return Ok(());
        }
        self.sender.as_ref().unwrap().try_send(job).map_err(|_|Failure::new("queue_full","compile","Source operation queue full"))
    }
    fn shutdown(&mut self){self.sender.take();self.entries.lock().take();if let Some(thread)=self.thread.take(){
        while !thread.is_finished(){let _=self.receiver.recv_timeout(Duration::from_millis(5));}
        let _=thread.join();
    }}
}
struct Build {
    request:PrivateRequest,snapshot:Arc<sources::Snapshot>,cancel:Arc<AtomicBool>,candidate:Option<Compiled>,assets:Option<Arc<sources::PinnedAssets>>,
    prepared:Option<PreparedNativeRevision>,ticket:Option<RevisionTicket>,reference:Value,initial:Value,effect:Value,authorized:bool,authorization:String,preparation_reported:bool,dependencies:Vec<Value>,
    superseded:bool,
}
#[derive(Clone)]
struct Subscription { detail:bool,meters:bool,detail_hz:u8,meter_hz:u8,source:Option<String> }
impl Default for Subscription {fn default()->Self {Self{detail:false,meters:true,detail_hz:30,meter_hz:20,source:None}}}
struct Control { request:PrivateRequest,stop_seek:bool,paused:bool,void:bool,expected_generation:u64,cancel:Arc<AtomicBool>,subscription:Option<Subscription> }
struct Restart { prepared:Option<PreparedNativeRevision>,ticket:RevisionTicket,request:String,authorization:String,authorized:bool }
struct Coordinator {
    output:Output,tokens:Tokens,early_cancels:EarlyCancels,epoch:Option<String>,project:Option<ProjectRef>,grants:Option<Arc<sources::Grants>>,
    uploads:BTreeMap<String,sources::Upload>,snapshots:BTreeMap<String,Arc<sources::Snapshot>>,snapshot_order:VecDeque<String>,
    runtime:Option<NativeRuntime>,final_status:Option<NativeStatus>,empty:muz::Session,current:Option<Arc<Accepted>>,previous:Option<Arc<Accepted>>,
    active:Option<Build>,queued:Option<PrivateRequest>,controls:HashMap<u64,Control>,restart:Option<Restart>,restart_requested:Option<PluginRestartRequest>,tail_pause:Option<NativeOperationId>,
    source:SourceWorker,exports:exports::Scheduler,analysis:analysis::Analysis,subscription:Subscription,meters:Value,
    resolved:VecDeque<String>,pending:HashMap<String,Context>,last_status:Instant,status_sequence:Cell<u64>,stopping:bool,
    deferred:VecDeque<PrivateRequest>,desired_audition:Option<PrivateRequest>,desired_analysis:Option<PrivateRequest>,
    latest_scan:Option<String>,analysis_clock:Option<(u64,u64)>,
    preview_waiter:Option<Context>,preview_frozen:bool,
}
impl Coordinator {
    fn new(output:Output,tokens:Tokens,early_cancels:EarlyCancels)->Self {
        Self{output,tokens,early_cancels,epoch:None,project:None,grants:None,uploads:BTreeMap::new(),snapshots:BTreeMap::new(),snapshot_order:VecDeque::new(),
            runtime:None,final_status:None,empty:empty_session(),current:None,previous:None,active:None,queued:None,controls:HashMap::new(),restart:None,restart_requested:None,tail_pause:None,
            source:SourceWorker::new(),exports:exports::Scheduler::new(),analysis:analysis::Analysis::new(),subscription:Subscription::default(),meters:json!([]),resolved:VecDeque::new(),pending:HashMap::new(),last_status:Instant::now(),status_sequence:Cell::new(0),stopping:false,
            deferred:VecDeque::new(),desired_audition:None,desired_analysis:None,latest_scan:None,analysis_clock:None,preview_waiter:None,preview_frozen:false}
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
        let explicit=self.pending.remove(&context.request_id).is_some();self.tokens.lock().remove(&context.request_id);
        if !explicit {if let Err(failure)=result {return self.output.event(context,"runtime",json!({"kind":"failure","failure":failure}));}return Ok(());}
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
        if !["hello","configureProject","preparePreview","resumeProject","format","shutdown","cancel","cancelExport"].contains(&request.command.as_str()) && context.project!=self.project {
            return self.output.reply(&context,Err(Failure::new("stale_request","engine","Project epoch does not match")));
        }
        if ["inspect","explain","location","diff","sourceDocument","transport","setAudition","setAnalysisSubscription","startExport"].contains(&request.command.as_str()){
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
        let attempted=request.clone();let result=self.dispatch(request);
        match result {Ok(Some(value))=>self.finish(&context,Ok(value)),Ok(None)=>Ok(()),Err(failure)=>{let failure=self.action_failure(&attempted,failure,false,None);self.finish(&context,Err(failure))}}
    }
    fn action_failure(&self,request:&PrivateRequest,mut failure:Failure,partial:bool,expected:Option<u64>)->Failure {
        let action=action(request);
        let outcome=if partial{"partial"}else{match failure.code.as_str(){"cancelled"=>"cancelled","superseded"=>"superseded","child_died"|"output_fault"=>"unknown",_=>"rejected"}};
        failure.operation=Some(json!({"action":action,"requestId":request.context.request_id,"ref":request.args.get("attemptedRef").or_else(||request.args.get("ref")).or_else(||request.args.get("base")).cloned().unwrap_or(Value::Null),
            "outcome":outcome,"continuity":failure.continuity,"phase":failure.phase,
            "expectedRuntimeRevision":failure.runtime.as_ref().and_then(|runtime|runtime["expectedRevision"].as_str()).map(str::to_owned).or_else(||expected.map(|revision|revision.to_string())),
            "actualRuntimeRevision":failure.runtime.as_ref().and_then(|runtime|runtime["observedRevision"].as_str()).map(str::to_owned).or_else(||self.runtime.as_ref().map(|runtime|runtime.status().runtime_revision.to_string()))}));
        failure
    }
    const DEFERRED_CONTROL_LIMIT:usize=32;
    fn boundary(&self)->bool {
        self.restart.is_some() || self.tail_pause.is_some() || self.active.as_ref().is_some_and(|build|build.candidate.is_some()||build.prepared.is_some()||build.ticket.is_some())
    }
    fn defer_control(&mut self,request:PrivateRequest)->Result<(),Failure> {
        if request.command=="setAudition"||request.command=="setAnalysisSubscription" {
            let old=if request.command=="setAudition"{self.desired_audition.replace(request)}else{self.desired_analysis.replace(request)};
            if let Some(old)=old {let failure=self.action_failure(&old,Failure::new("superseded","transport","A newer desired state replaced this request"),false,None);self.finish(&old.context,Err(failure)).map_err(engine_failure)?;}
        } else {
            if self.deferred.len()>=Self::DEFERRED_CONTROL_LIMIT{return Err(Failure::new("queue_full","transport","Deferred explicit operation budget exceeded"));}
            self.deferred.push_back(request);
        }Ok(())
    }
    fn resume_controls(&mut self)->anyhow::Result<()> {
        if self.boundary()||!self.controls.is_empty(){return Ok(());}
        let request=self.deferred.pop_front().or_else(||self.desired_audition.take()).or_else(||self.desired_analysis.take());
        if let Some(mut request)=request {
            if global_control(&request)||request.command=="setAnalysisSubscription" {if let Some(current)=&self.current {request.args["attemptedRef"]=request.args["ref"].clone();request.args["ref"]=current.reference.clone();}}
            let attempted=request.clone();
            if let Err(failure)=self.submit_control(request){let failure=self.action_failure(&attempted,failure,false,None);self.finish(&attempted.context,Err(failure))?;}
        }Ok(())
    }
    fn settle_control(&mut self,control:Control,result:Result<Value,Failure>,expected:u64)->anyhow::Result<()> {
        let result=result.map_err(|failure|self.action_failure(&control.request,failure,control.paused,Some(expected)));
        self.finish(&control.request.context,result)
    }
    fn register_subscription(&mut self)->anyhow::Result<()> {
        self.analysis.clear();self.analysis_clock=None;self.output.telemetry.lock().analysis=None;
        let Some(current)=&self.current else{return Ok(());};
        if self.subscription.source.as_ref().is_some_and(|id|!current.compiled.session.tracks.iter().any(|track|track.id.to_string()==*id)) {
            self.subscription.detail=false;self.subscription.source=None;
        }
        if self.desired_analysis.is_none() {
            let mut context=self.context();context.revision=current.reference["revision"].as_str().map(str::to_owned);context.source_version=current.reference["sourceVersion"].as_u64();
            self.desired_analysis=Some(PrivateRequest{context,command:"setAnalysisSubscription".into(),args:json!({"ref":current.reference,"subscription":{
                "detail":self.subscription.detail,"meters":self.subscription.meters,"detailHz":self.subscription.detail_hz,"meterHz":self.subscription.meter_hz,"source":self.subscription.source}})});
        }Ok(())
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
                let trusted=args["trustedRead"].as_bool().ok_or_else(||invalid("Missing parent read policy"))?;
                let grants=if args["readBindings"].as_array().is_some_and(Vec::is_empty){None}else{Some(sources::Grants::new(args["readBindings"].clone(),trusted)?)};
                if self.project.as_ref()!=Some(&project){self.retire_project().map_err(engine_failure)?;}
                self.project=Some(project);self.grants=grants;Ok(Some(Value::Null))
            },
            "preparePreview"=>{
                if self.preview_waiter.is_some(){return Err(Failure::new("queue_full","project","Imported preview transition is already awaiting receipts"));}
                self.preview_frozen=true;
                if let Some(queued)=self.queued.take(){let failure=self.action_failure(&queued,Failure::new("superseded","compile","Imported preview replaced the queued candidate"),false,None);self.finish(&queued.context,Err(failure)).map_err(engine_failure)?;}
                if let Some(active)=&mut self.active {
                    active.superseded=true;active.cancel.store(true,Ordering::Relaxed);
                    if let Some(ticket)=active.ticket {self.runtime.as_mut().unwrap().cancel_operation(ticket.operation).map_err(|error|native_failure(error,"apply"))?;}
                }
                if let Some(scan)=self.latest_scan.take(){self.token(&scan).store(true,Ordering::Relaxed);if let Some(context)=self.pending.get(&scan).cloned(){self.finish(&context,Err(Failure::new("superseded","compile","Imported preview replaced entry discovery"))).map_err(engine_failure)?;}}
                self.source.entries.lock().take();self.preview_waiter=Some(request.context);Ok(None)
            },
            "resumeProject"=>{self.preview_frozen=false;Ok(Some(Value::Null))},
            "snapshotBegin"=>{
                if !self.grants.as_ref().is_some_and(|policy|policy.trusted){return Err(Failure::new("trust_required","compile","Parent trust is required before evaluating imported content"));}
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
                if self.preview_frozen{return Err(Failure::new("trust_required","compile","Entry evaluation is suspended while imported content is a preview"));}
                let snapshot=self.snapshot(string(args,"snapshot")?)?;
                if request.context.source_version!=snapshot.descriptor["sourceVersion"].as_u64(){return Err(Failure::new("stale_request","compile","Entry check source version does not match snapshot"));}
                if let Some(previous)=self.latest_scan.replace(request.context.request_id.clone()){
                    self.token(&previous).store(true,Ordering::Relaxed);
                    if let Some(context)=self.pending.get(&previous).cloned(){self.finish(&context,Err(Failure::new("superseded","compile","A newer source capture replaced entry discovery"))).map_err(engine_failure)?;}
                }
                let cancel=self.token(&request.context.request_id);self.source.submit(SourceJob::Entries{request,snapshot,cancel})?;Ok(None)
            },
            "rebuild"=>{
                if self.preview_frozen{return Err(Failure::new("trust_required","compile","Builds are suspended until the imported preview is trusted or cancelled"));}
                self.snapshot(string(args,"snapshot")?)?;
                if let Some(previous)=self.latest_scan.take(){
                    self.token(&previous).store(true,Ordering::Relaxed);
                    if let Some(context)=self.pending.get(&previous).cloned(){self.finish(&context,Err(Failure::new("superseded","compile","Explicit rebuild replaced entry discovery"))).map_err(engine_failure)?;}
                    self.source.entries.lock().take();
                }
                if self.active.is_some()||self.restart.is_some(){
                    if let Some(old)=self.queued.replace(request.clone()){let failure=self.action_failure(&old,Failure::new("superseded","compile","A newer build replaced the queued candidate"),false,None);self.finish(&old.context,Err(failure)).map_err(engine_failure)?;}
                    if let Some(active)=&mut self.active {if active.ticket.is_none(){active.superseded=true;active.cancel.store(true,Ordering::Relaxed);}}
                    self.build_event(&request,"queued",None).map_err(engine_failure)?;
                }else{self.start_build(request)?;}
                Ok(None)
            },
            "authorizeApply"=>{
                let target=string(args,"target")?;
                if self.restart.as_ref().is_some_and(|restart|restart.request==target) {
                    let restart=self.restart.as_mut().unwrap();
                    if restart.authorization!=string(args,"authorization")? {return Err(Failure::new("superseded","apply","Plugin restart authorization expired"));}
                    if args["allowed"]==true {restart.authorized=true;} else {
                        self.restart=None;
                        let failure=serde_json::from_value::<Failure>(args["failure"].clone()).unwrap_or_else(|_|Failure::new("changed_asset","apply","Retained plugin resources failed authorization"));
                        self.output.event(&request.context,"runtime",json!({"kind":"failure","failure":failure})).map_err(engine_failure)?;
                    }
                    return Ok(Some(Value::Null));
                }
                let active=self.active.as_mut().filter(|b|b.request.context.request_id==target).ok_or_else(||Failure::new("stale_request","apply","Prepared request expired"))?;
                if active.prepared.is_none()||active.ticket.is_some(){return Err(Failure::new("stale_request","apply","Request is not awaiting authorization"));}
                if args["authorization"].as_str()!=Some(active.authorization.as_str()){return Err(Failure::new("superseded","apply","Authorization targets an obsolete preparation"));}
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
            "sourceDocument"=>{let accepted=self.lookup(&args["ref"],false)?;Ok(Some(accepted.assets.document(Path::new(string(args,"path")?))?.unwrap_or(Value::Null)))},
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
        self.active=Some(Build{request,snapshot,cancel,candidate:None,assets:None,prepared:None,ticket:None,reference:Value::Null,initial:Value::Null,effect:Value::Null,authorized:false,authorization:String::new(),superseded:false,preparation_reported:false,dependencies:Vec::new()});Ok(())
    }
    fn build_event(&mut self,request:&PrivateRequest,phase:&str,failure:Option<&Failure>)->anyhow::Result<()> {
        self.output.event(&request.context,"runtime",json!({"kind":"build","requestId":request.context.request_id,"project":request.context.project,"sourceVersion":request.context.source_version,"phase":phase,"ref":if phase=="accepted"{self.current.as_ref().map(|a|a.reference.clone()).unwrap_or(Value::Null)}else{Value::Null},"failure":failure}))
    }
    fn reject_build(&mut self,mut failure:Failure)->anyhow::Result<()> {
        if self.current.is_none(){failure.continuity="not-started".into();}
        if let Some(build)=self.active.take(){
            if build.superseded && failure.code=="cancelled" {failure.code="superseded".into();failure.message="A newer build superseded this unsubmitted candidate".into();}
            failure=self.action_failure(&build.request,failure,false,build.ticket.map(|ticket|ticket.revision));
            build.cancel.store(true,Ordering::Relaxed);
            self.build_event(&build.request,if failure.code=="cancelled"{"cancelled"}else{"rejected"},Some(&failure))?;
            self.finish(&build.request.context,Err(failure))?;
        }Ok(())
    }
    fn compiled(&mut self,id:String,result:Result<(Compiled,Arc<sources::PinnedAssets>),Failure>)->anyhow::Result<()> {
        if !self.active.as_ref().is_some_and(|b|b.request.context.request_id==id){return Ok(());}
        let (mut candidate,assets)=match result{Ok(value)=>value,Err(f)=>return self.reject_build(f)};
        if self.active.as_ref().unwrap().cancel.load(Ordering::Relaxed){return self.reject_build(cancelled("compile"));}
        if !self.controls.is_empty()||self.tail_pause.is_some()||self.restart.is_some(){
            let active=self.active.as_mut().unwrap();active.candidate=Some(candidate);active.assets=Some(assets);return Ok(());
        }
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
        let dependencies=match dependency_manifest(&assets){Ok(dependencies)=>dependencies,Err(failure)=>return self.reject_build(failure)};
        if serde_json::to_vec(&dependencies)?.len()>protocol::FRAME_BYTES-4096{
            return self.reject_build(Failure::new("resource_budget","prepare","Dependency manifest exceeds private validation budget"));
        }
        let active=self.active.as_mut().unwrap();active.candidate=Some(candidate);active.assets=Some(assets);active.prepared=Some(prepared);active.reference=reference;active.initial=initial;active.effect=effect;
        active.authorized=false;active.authorization=uuid::Uuid::new_v4().to_string();active.dependencies=dependencies.clone();
        let authorization=active.authorization.clone();
        self.output.event(&request.context,"internal",json!({"kind":"prepared","requestId":request.context.request_id,"authorization":authorization,"snapshot":request.args["snapshot"],"dependencyVersions":dependencies}))
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
            Err(error)=>{
                if error.error.code==NativeErrorCode::QueueFull||error.error.code==NativeErrorCode::Busy{self.active.as_mut().unwrap().prepared=Some(error.prepared);}
                else if error.error.code==NativeErrorCode::Superseded {
                    // Retain the exact compilation and pins, but recapture acknowledged
                    // runtime policy and renew parent authorization before submission.
                    let active=self.active.as_mut().unwrap();active.authorized=false;active.authorization.clear();
                }else{return self.reject_build(native_failure(error.error,"apply"));}
            }
        }Ok(())
    }
    fn cancel(&mut self,target:&str)->Result<&'static str,Failure>{
        if self.resolved.iter().any(|s|s==target){return Ok("finished");}
        if !self.pending.contains_key(target){return Ok(if self.exports.cancel(target){"requested"}else{"unknown"});}
        self.token(target).store(true,Ordering::Relaxed);
        if self.queued.as_ref().is_some_and(|q|q.context.request_id==target){let queued=self.queued.take().unwrap();self.finish(&queued.context,Err(cancelled("compile"))).map_err(engine_failure)?;}
        if let Some(active)=&self.active{if active.request.context.request_id==target{if let Some(ticket)=active.ticket{self.runtime.as_mut().unwrap().cancel_operation(ticket.operation).map_err(|e|native_failure(e,"apply"))?;}}}
        let operations:Vec<u64>=self.controls.iter().filter(|(_,c)|c.request.context.request_id==target).map(|(id,_)|*id).collect();
        for operation in operations{self.runtime.as_mut().unwrap().cancel_operation(NativeOperationId(operation)).map_err(|e|native_failure(e,"transport"))?;}
        self.exports.cancel(target);Ok("requested")
    }
    fn control(&mut self,request:PrivateRequest)->Result<(),Failure>{
        if self.token(&request.context.request_id).load(Ordering::Relaxed){return Err(cancelled("transport"));}
        if self.preview_frozen&&!global_control(&request)&&request.command!="setAnalysisSubscription"{
            return Err(Failure::new("trust_required","transport","Score-bound controls are disabled while imported content is a preview"));
        }
        self.defer_control(request)
    }
    fn submit_control(&mut self,request:PrivateRequest)->Result<(),Failure>{
        let cancel=self.token(&request.context.request_id);if cancel.load(Ordering::Relaxed){return Err(cancelled("transport"));}
        let accepted=self.lookup(&request.args["ref"],true)?.clone();
        let runtime=self.runtime.as_mut().ok_or_else(||Failure::new("audio_unavailable","transport","Native output is not running"))?;
        let before=runtime.status().transport;let generation=before.generation;let was_running=before.snapshot.running;let revision=accepted.runtime_revision;
        let context=sources::context(accepted.assets.clone(),cancel.clone());
        let mut stop_seek=false;let mut void=false;
        let ticket=match request.command.as_str(){
            "setAudition"=>{void=true;let ids:Vec<String>=serde_json::from_value(request.args["physicalIds"].clone()).map_err(|e|invalid(e.to_string()))?;
                if ids.iter().any(|id|!accepted.compiled.session.tracks.iter().any(|track|track.id.to_string()==*id)){return Err(Failure::new("stale_revision","transport","Listening selection includes a removed track"));}
                runtime.set_audibility(revision,&ids)},
            "setAnalysisSubscription"=>{
                void=true;let subscription=subscription(&request.args)?;
                let analysis=if subscription.detail{Some(match subscription.source.clone(){Some(id)=>ObservationTarget::Track(id),None=>ObservationTarget::Master})}else{None};
                let tracks=if subscription.meters {accepted.compiled.session.tracks.iter().map(|t|t.id.to_string()).collect::<Vec<_>>()}else{Vec::new()};
                if tracks.len()>1000{return Err(Failure::new("resource_budget","transport","Track meter subscription exceeds 1000 physical tracks"));}
                if subscription.source.as_ref().is_some_and(|id|!accepted.compiled.session.tracks.iter().any(|track|track.id.to_string()==*id)){return Err(Failure::new("stale_revision","transport","Analysis source no longer exists"));}
                runtime.set_observation(revision,&ObservationSelection{meter_tracks:tracks,master_meter:subscription.meters,analysis,meter_hz:if subscription.meters{subscription.meter_hz}else{0},analysis_hz:if subscription.detail{subscription.detail_hz}else{0}})
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
        let subscription=if request.command=="setAnalysisSubscription"{Some(subscription(&request.args)?)}else{None};
        self.controls.insert(ticket.operation.0,Control{request,stop_seek,paused:false,void,expected_generation,cancel,subscription});Ok(())
    }
    fn status(&self,transport:Option<NativeTransportStatus>)->Result<Value,Failure>{
        let accepted=self.current.as_ref().ok_or_else(||Failure::new("stale_revision","transport","No accepted revision"))?;
        let status=self.runtime.as_ref().map(NativeRuntime::status).or_else(||self.final_status.clone()).ok_or_else(||Failure::new("audio_unavailable","transport","Native output unavailable"))?;
        let t=transport.unwrap_or(status.transport);let snapshot=t.snapshot;let playing=snapshot.running;
        let ppq=accepted.compiled.session.tracks.iter().find_map(|track|match &track.source{muz::model::TrackSource::Midi(midi)=>Some(midi.summary.ppq as f64),_=>None}).unwrap_or(muz::model::TICKS_PER_BEAT as f64);
        let sequence=self.status_sequence.get().checked_add(1).ok_or_else(||Failure::new("resource_budget","transport","Transport status sequence exhausted"))?;self.status_sequence.set(sequence);
        Ok(json!({"ref":accepted.reference,"generation":t.generation.to_string(),"sequence":sequence.to_string(),"playing":playing,"finished":tail_complete(t,accepted.compiled.session.extras.tail),
            "beat":snapshot.beat_position,"seconds":snapshot.project_frame/snapshot.sample_rate,"bpm":snapshot.bpm,"meter":snapshot.meter,
            "duration":t.end_project_frame/snapshot.sample_rate,"endBeat":t.end_tick as f64/ppq,"tail":accepted.compiled.session.extras.tail,
            "loop":t.loop_range.map(|(start,end)|[start as f64/960000.,end as f64/960000.]),"peak":if playing{status.last_peak}else{0.},"rms":if playing{status.last_rms}else{0.},
            "meters":if playing{self.meters.clone()}else{json!([])},"audio":audio_configuration(&status),
            "health":{"acceptedRevision":status.accepted_revision.to_string(),"runtimeRevision":status.runtime_revision.to_string(),"sourceGeneration":status.source_generation.to_string(),"runtimeMappingPending":status.runtime_mapping_pending,
                "deliveredEvents":counter_fields(json!(status.delivered_events),&["note_ons","note_offs","controllers"]),
                "devices":status.devices.iter().map(|device|counter_fields(json!(device),&["instance_token","process_count"])).collect::<Vec<_>>(),
                "streamStartCount":status.stream_start_count.to_string(),
                "audio":counter_fields(json!(status.audio),&["stream_generation","callback_count","render_faults","stream_errors","transaction_commits","transaction_faults","structural_commits"]),
                "observationDropped":status.observation_dropped.to_string()}}))
    }
    fn native_event(&mut self,event:NativeEvent)->anyhow::Result<()> {
        match event {
            NativeEvent::RevisionApplied{ticket,transport,plugin_stamp,..}=>{
                if self.active.as_ref().is_some_and(|b|b.ticket==Some(ticket)){
                    let mut build=self.active.take().unwrap();let mut compiled=build.candidate.take().unwrap();plugin_stamp.apply(&mut compiled.session);
                    let assets=build.assets.take().unwrap();let dependencies=build.dependencies;
                    let accepted=Arc::new(Accepted{compiled,reference:build.reference,assets,runtime_revision:ticket.revision,snapshot:string(&build.request.args,"snapshot")?.to_owned(),dependencies});
                    self.previous=self.current.replace(accepted);self.meters=json!([]);
                    let value=json!({"ref":self.current.as_ref().unwrap().reference,"status":self.status(Some(transport))?,"effect":build.effect,"initialPages":build.initial,"exportTracks":inspection::export_tracks(&self.current.as_ref().unwrap().compiled)});
                    self.build_event(&build.request,"accepted",None)?;self.finish(&build.request.context,Ok(value))?;
                    self.output.event(&self.context(),"runtime",json!({"kind":"engine","state":"ready","engineEpoch":self.epoch,"capabilities":self.capabilities(),"failure":null}))?;
                    self.register_subscription()?;
                }else if self.restart.as_ref().is_some_and(|r|r.ticket==ticket){
                    self.restart.take();if let Some(current)=self.current.as_mut(){
                        // Export jobs keep their original accepted compilation immutable.
                        let accepted=Arc::make_mut(current);
                        plugin_stamp.apply(&mut accepted.compiled.session);accepted.runtime_revision=ticket.revision;
                    }
                    self.register_subscription()?;
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
                        control.stop_seek=false;control.paused=true;self.analysis.clear();self.analysis_clock=None;self.output.telemetry.lock().analysis=None;
                        if control.cancel.load(Ordering::Relaxed)||self.runtime.is_none(){self.settle_control(control,Err(Failure::new("cancelled","transport","Stop paused playback but did not rewind: cancellation arrived between its receipts")),ticket.expected_revision)?;}
                        else if let Some(accepted)=&self.current{
                            if accepted.runtime_revision!=ticket.expected_revision || transport.generation!=control.expected_generation {self.settle_control(control,Err(Failure::new("stale_transport","transport","Stop paused playback but did not rewind: transport changed")),ticket.expected_revision)?;}
                            else{
                                let context=sources::context(accepted.assets.clone(),control.cancel.clone());
                                match self.runtime.as_mut().unwrap().seek_ticks(&accepted.compiled.session,ticket.expected_revision,0,&context){
                                    Ok(next)=>{self.controls.insert(next.operation.0,control);},Err(error)=>self.settle_control(control,Err(native_failure(error,"transport")),ticket.expected_revision)?,
                                }
                            }
                        }
                        else {self.settle_control(control,Err(Failure::new("stale_revision","transport","Stop paused playback but no accepted revision remains for rewind")),ticket.expected_revision)?;}
                    }else{
                        if let Some(subscription)=control.subscription.take(){if !subscription.meters{self.meters=json!([]);}self.subscription=subscription;self.analysis.clear();self.analysis_clock=None;self.output.telemetry.lock().analysis=None;}
                        if !transport.snapshot.running||matches!(action(&control.request).as_str(),"seek"|"loop"|"restart"|"panic") {self.analysis.clear();self.analysis_clock=None;self.output.telemetry.lock().analysis=None;}
                        let result=if control.void{Ok(Value::Null)}else{self.status(Some(transport))};
                        self.settle_control(control,result,ticket.expected_revision)?;
                    }
                }
            },
            NativeEvent::ControlRejected{ticket,error,..}=>{
                if self.tail_pause==Some(ticket.operation){self.tail_pause=None;}
                if let Some(control)=self.controls.remove(&ticket.operation.0){self.settle_control(control,Err(native_failure(error,"transport")),ticket.expected_revision)?;}
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
        if !self.preview_frozen&&!self.boundary()&&self.controls.is_empty() {
        if let (Some(runtime),Some(current))=(&mut self.runtime,&self.current){
            if let Err(error)=runtime.service_plugins(&current.compiled.session,current.runtime_revision){
                if error.code!=NativeErrorCode::Busy{self.output.event(&self.context(),"runtime",json!({"kind":"failure","failure":native_failure(error,"engine")}))?;}
            }
        }
        }
        if !self.preview_frozen&&self.active.is_none()&&self.restart.is_none()&&self.controls.is_empty()&&self.tail_pause.is_none(){
            if let (Some(request),Some(current),Some(runtime))=(self.restart_requested.take(),self.current.as_ref(),self.runtime.as_mut()){
                if request.expected_revision==current.runtime_revision{
                    let context=sources::context(current.assets.clone(),Arc::new(AtomicBool::new(false)));
                    match runtime.prepare_plugin_restart(&current.compiled.session,current.runtime_revision,current.reference["sourceVersion"].as_u64().unwrap_or(0),&request,&context){
                        Ok(prepared)=>{
                            let ticket=prepared.ticket();let authorization=uuid::Uuid::new_v4().to_string();let request_id=uuid::Uuid::new_v4().to_string();
                            let mut envelope=Context::host(self.epoch.clone(),self.project.clone());envelope.request_id=request_id.clone();
                            envelope.revision=current.reference["revision"].as_str().map(str::to_owned);envelope.source_version=current.reference["sourceVersion"].as_u64();
                            self.output.event(&envelope,"internal",json!({"kind":"prepared","requestId":request_id,"authorization":authorization,"snapshot":current.snapshot,"retained":true,"ref":current.reference,"dependencyVersions":current.dependencies}))?;
                            self.restart=Some(Restart{prepared:Some(prepared),ticket,request:request_id,authorization,authorized:false});
                        },
                        Err(error)=>self.output.event(&self.context(),"runtime",json!({"kind":"failure","failure":native_failure(error,"prepare")}))?,
                    }
                }
            }
        }
        if let Some(restart)=&mut self.restart{if restart.authorized {if let Some(prepared)=restart.prepared.take(){
            match self.runtime.as_mut().unwrap().submit_revision(prepared){Ok(_)=>{},Err(error)=>{
                if error.error.code==NativeErrorCode::QueueFull{restart.prepared=Some(error.prepared);}else{self.restart.take();self.output.event(&self.context(),"runtime",json!({"kind":"failure","failure":native_failure(error.error,"apply")}))?;}
            }}
        }}}Ok(())
    }
    fn export_event(&mut self,event:exports::ExportEvent)->anyhow::Result<()> {
        match event {
            exports::ExportEvent::Progress{context,job,reference,phase,progress}=>self.output.event(&context,"runtime",json!({"kind":"exportProgress","requestId":context.request_id,"job":job,"ref":reference,"phase":phase,"progress":progress})),
            exports::ExportEvent::Finished{context,result,..}=>self.finish(&context,result),
        }
    }
    fn service(&mut self)->anyhow::Result<()> {
        if let Some(runtime)=&mut self.runtime{let mut events:[Option<NativeEvent>;64]=std::array::from_fn(|_|None);runtime.poll(&mut events);for event in events.into_iter().flatten(){self.native_event(event)?;}}
        self.resume_controls()?;
        loop{
            let result=match self.source.receiver.try_recv(){
                Ok(result)=>result,Err(mpsc::TryRecvError::Empty)=>break,
                Err(mpsc::TryRecvError::Disconnected)=>return Err(anyhow::anyhow!("Source compiler thread exited unexpectedly")),
            };
            match result{
            SourceResult::Build{id,result}=>self.compiled(id,result)?,
            SourceResult::Reply{context,result}=>{
                if self.latest_scan.as_deref()==Some(context.request_id.as_str()){self.latest_scan=None;}
                if self.pending.contains_key(&context.request_id){self.finish(&context,if self.token(&context.request_id).load(Ordering::Relaxed){Err(cancelled("compile"))}else{result})?;}
            },
            SourceResult::Progress{context,snapshot,done,total,current_entry,result}=>{
                if self.latest_scan.as_deref()==Some(context.request_id.as_str())&&self.pending.contains_key(&context.request_id)&&!self.token(&context.request_id).load(Ordering::Relaxed) {
                    self.output.event(&context,"runtime",json!({"kind":"entries","requestId":context.request_id,"snapshot":snapshot,"done":done,"total":total,"currentEntry":current_entry,"result":result}))?;
                }
            },
        }}
        if self.active.as_ref().is_some_and(|b|b.candidate.is_some()&&b.prepared.is_none()&&b.ticket.is_none()){
            let active=self.active.as_mut().unwrap();let id=active.request.context.request_id.clone();
            let candidate=active.candidate.take().unwrap();let assets=active.assets.take().unwrap();
            self.compiled(id,Ok((candidate,assets)))?;
        }
        self.submit_build()?;self.plugin_service()?;
        if self.active.is_none()&&self.restart.is_none(){if let Some(request)=self.queued.take(){let context=request.context.clone();if let Err(failure)=self.start_build(request){self.finish(&context,Err(failure))?;}}}
        if self.preview_waiter.is_some()&&self.active.is_none()&&self.restart.is_none()&&self.controls.is_empty()&&self.deferred.is_empty()&&self.desired_audition.is_none()&&self.desired_analysis.is_none()&&self.tail_pause.is_none() {
            let context=self.preview_waiter.take().unwrap();let result=if self.token(&context.request_id).load(Ordering::Relaxed){Err(cancelled("project"))}else{Ok(Value::Null)};self.finish(&context,result)?;
        }
        for event in self.exports.poll(){self.export_event(event)?;}
        if let (Some(runtime),Some(current))=(&mut self.runtime,&self.current){
            let transport=runtime.status().transport;
            if self.tail_pause.is_none()&&self.controls.is_empty()&&self.active.is_none()&&self.restart.is_none()
                &&transport.snapshot.running&&tail_complete(transport,current.compiled.session.extras.tail){
                if let Ok(ticket)=runtime.set_running(current.runtime_revision,false){self.tail_pause=Some(ticket.operation);}
            }
            let mut frames:[Option<ObservationFrame>;4]=std::array::from_fn(|_|None);runtime.drain_observations(&mut frames);
            for frame in frames.into_iter().flatten(){if frame.revision==current.runtime_revision{
                if frame.meters_present {self.meters=json!(frame.tracks.iter().map(|m|json!({"track":m.id,"peak":if frame.running{m.peak}else{0.},"rms":if frame.running{m.rms}else{0.}})).collect::<Vec<_>>());}
                let clock=(frame.transport_generation,frame.capture_epoch);
                if self.analysis_clock!=Some(clock){self.analysis.clear();self.output.telemetry.lock().analysis=None;self.analysis_clock=Some(clock);}
                if self.subscription.detail&&frame.running&&!frame.mono_samples.is_empty(){self.analysis.submit(current.reference.clone(),frame);}
            }}
        }
        while let Some(frame)=self.analysis.poll(){
            if self.subscription.detail && self.current.as_ref().is_some_and(|a|a.reference==frame["ref"])
                && frame["source"].as_str()==self.subscription.source.as_deref()
                && self.analysis_clock.is_some_and(|(generation,capture)|frame["generation"]==generation.to_string()&&frame["captureId"]==capture.to_string())
                && self.runtime.as_ref().is_some_and(|r|r.status().transport.snapshot.running&&frame["generation"]==r.status().transport.generation.to_string()){
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
        self.deferred.clear();self.desired_audition=None;self.desired_analysis=None;self.latest_scan=None;self.analysis_clock=None;
        self.tail_pause=None;
        self.preview_waiter=None;self.preview_frozen=false;
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
            while let Ok(frame)=frames.try_recv(){write_ordered(&mut writer,&mut sequence,frame)?;}
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
    let code=match error.code{NativeErrorCode::Cancelled=>"cancelled",NativeErrorCode::Superseded=>"superseded",NativeErrorCode::StaleRevision=>"stale_revision",NativeErrorCode::SessionMismatch=>"session_mismatch",NativeErrorCode::Busy|NativeErrorCode::QueueFull=>"queue_full",NativeErrorCode::ResourceLimit|NativeErrorCode::RevisionOverflow=>"resource_budget",NativeErrorCode::AudioUnavailable=>"audio_unavailable",NativeErrorCode::OutputFault=>"output_fault",NativeErrorCode::UnknownOperation=>"stale_request",NativeErrorCode::Shutdown=>"child_died",_=>"invalid_source"};
    let runtime=json!({"code":format!("{:?}",error.code),"expectedRevision":error.expected_revision.map(|revision|revision.to_string()),"observedRevision":error.observed_revision.map(|revision|revision.to_string())});
    let mut failure=sources::diagnostic_failure(Failure::new(code,phase,error.message),error.diagnostic.as_ref());failure.runtime=Some(runtime);failure
}
fn counter_fields(mut value:Value,fields:&[&str])->Value{
    for field in fields{if let Some(counter)=value[*field].as_u64(){value[*field]=json!(counter.to_string());}}value
}
fn dependency_manifest(assets:&sources::PinnedAssets)->Result<Vec<Value>,Failure> {
    let mut unique=BTreeMap::new();
    for dependency in assets.dependencies() {
        let key=(string(&dependency,"grant")?.to_owned(),string(&dependency,"path")?.to_owned());
        if let Some(previous)=unique.insert(key,dependency.clone()) {if previous!=dependency{return Err(Failure::new("changed_asset","prepare","Source and asset capture disagree about one dependency"));}}
        if unique.len()>8192{return Err(Failure::new("resource_budget","prepare","Dependency manifest exceeds the consumed-file budget"));}
    }
    Ok(unique.into_values().collect())
}
fn action(request:&PrivateRequest)->String {
    match request.command.as_str() {
        "transport"=>request.args["command"]["kind"].as_str().unwrap_or("project").to_owned(),
        "setAudition"=>"audition".into(),"setAnalysisSubscription"=>"analysis".into(),"rebuild"=>"rebuild".into(),
        "checkEntries"=>"classifyEntries".into(),"startExport"=>"export".into(),"format"=>"format".into(),
        "inspect"|"explain"|"location"|"diff"=>"inspect".into(),_=>"project".into(),
    }
}
fn global_control(request:&PrivateRequest)->bool {request.command=="transport"&&matches!(request.args["command"]["kind"].as_str(),Some("play"|"pause"|"stop"|"panic"))}
fn subscription(args:&Value)->Result<Subscription,Failure> {
    let args=&args["subscription"];
    let detail=args["detail"].as_bool().ok_or_else(||invalid("Missing detail flag"))?;
    let meters=args["meters"].as_bool().ok_or_else(||invalid("Missing meters flag"))?;
    let rate=|key:&str,max:u64,enabled:bool|args[key].as_u64().filter(|rate|*rate<=max&&(!enabled||*rate>0)).map(|rate|rate as u8).ok_or_else(||invalid(format!("Invalid {key}")));
    Ok(Subscription{detail,meters,detail_hz:rate("detailHz",30,detail)?,meter_hz:rate("meterHz",20,meters)?,source:args["source"].as_str().map(str::to_owned)})
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
    fn reliable_acceptance_barrier_discards_older_coalesced_telemetry(){
        let (reliable,receiver)=mpsc::sync_channel(1);
        let pending=Arc::new(Mutex::new(Telemetry{status:None,analysis:None,dropped:0}));
        let mut output=Output{reliable,telemetry:pending.clone(),sequence:0};
        let context=Context::host(Some("engine".into()),Some(ProjectRef{project:"project".into(),epoch:"epoch".into()}));
        let reference=json!({"project":"project","epoch":"epoch","engineEpoch":"engine","sourceVersion":7,"revision":"accepted"});
        output.telemetry(&context,json!({"kind":"status","status":{"ref":reference}})).unwrap();
        output.telemetry(&context,json!({"kind":"analysis","frame":{"ref":reference,"dropped":"0"}})).unwrap();
        output.event(&context,"runtime",json!({"kind":"build","phase":"accepted","ref":reference})).unwrap();
        assert!(pending.lock().status.is_none());assert!(pending.lock().analysis.is_none());
        assert_eq!(receiver.recv().unwrap()["barrier"],true);
    }
    #[test]
    fn health_counters_never_round_trip_through_javascript_numbers(){
        let value=counter_fields(json!({"callback_count":u64::MAX,"rate":48000}),&["callback_count"]);
        assert_eq!(value["callback_count"],"18446744073709551615");assert_eq!(value["rate"],48000);
    }
    #[test]
    fn desired_controls_are_latest_wins_while_explicit_controls_remain_bounded_and_ordered(){
        let (reliable,receiver)=mpsc::sync_channel(4);
        let output=Output{reliable,telemetry:Arc::new(Mutex::new(Telemetry{status:None,analysis:None,dropped:0})),sequence:0};
        let mut coordinator=Coordinator::new(output,Arc::new(Mutex::new(HashMap::new())),Arc::new(Mutex::new(VecDeque::new())));
        let request=|id:&str,command:&str,args:Value|{let mut context=Context::host(Some("engine".into()),Some(ProjectRef{project:"project".into(),epoch:"epoch".into()}));context.request_id=id.into();PrivateRequest{context,command:command.into(),args}};
        let first=request("first","setAudition",json!({"ref":null,"state":{}}));
        coordinator.pending.insert(first.context.request_id.clone(),first.context.clone());coordinator.defer_control(first).unwrap();
        coordinator.defer_control(request("latest","setAudition",json!({"ref":null,"state":{}}))).unwrap();
        let failure=receiver.recv().unwrap();assert_eq!(failure["failure"]["operation"]["action"],"audition");assert_eq!(failure["failure"]["operation"]["outcome"],"superseded");
        assert_eq!(coordinator.desired_audition.as_ref().unwrap().context.request_id,"latest");assert!(!coordinator.pending.contains_key("first"));
        for index in 0..Coordinator::DEFERRED_CONTROL_LIMIT{coordinator.defer_control(request(&index.to_string(),"transport",json!({"command":{"kind":"play"}}))).unwrap();}
        assert_eq!(coordinator.deferred.front().unwrap().context.request_id,"0");assert_eq!(coordinator.deferred.back().unwrap().context.request_id,(Coordinator::DEFERRED_CONTROL_LIMIT-1).to_string());
        assert_eq!(coordinator.defer_control(request("overflow","transport",json!({"command":{"kind":"pause"}}))).unwrap_err().code,"queue_full");
        assert!(global_control(&request("stop","transport",json!({"command":{"kind":"stop"}}))));
        assert!(!global_control(&request("seek","transport",json!({"command":{"kind":"seek","tick":"0"}}))));
        let partial=coordinator.action_failure(&request("stop","transport",json!({"ref":null,"command":{"kind":"stop"}})),cancelled("transport"),true,Some(u64::MAX));
        assert_eq!(partial.operation.as_ref().unwrap()["outcome"],"partial");assert_eq!(partial.operation.as_ref().unwrap()["expectedRuntimeRevision"],"18446744073709551615");
        coordinator.source.shutdown();
    }
    #[test]
    fn cancelled_deferred_head_cannot_allow_later_play_to_pass_stop(){
        let (reliable,receiver)=mpsc::sync_channel(4);
        let output=Output{reliable,telemetry:Arc::new(Mutex::new(Telemetry{status:None,analysis:None,dropped:0})),sequence:0};
        let mut coordinator=Coordinator::new(output,Arc::new(Mutex::new(HashMap::new())),Arc::new(Mutex::new(VecDeque::new())));
        let request=|id:&str,kind:&str|{let mut context=Context::host(Some("engine".into()),Some(ProjectRef{project:"project".into(),epoch:"epoch".into()}));context.request_id=id.into();PrivateRequest{context,command:"transport".into(),args:json!({"ref":null,"command":{"kind":kind}})}};
        let head=request("cancelled","seek");
        coordinator.pending.insert(head.context.request_id.clone(),head.context.clone());
        coordinator.control(head).unwrap();coordinator.control(request("stop","stop")).unwrap();
        coordinator.token("cancelled").store(true,Ordering::Relaxed);
        coordinator.resume_controls().unwrap();
        assert_eq!(receiver.recv().unwrap()["failure"]["operation"]["outcome"],"cancelled");
        coordinator.control(request("later-play","play")).unwrap();
        assert_eq!(coordinator.deferred.iter().map(|request|request.context.request_id.as_str()).collect::<Vec<_>>(),["stop","later-play"]);
        coordinator.source.shutdown();
    }
    #[test]
    fn incoming_analysis_replaces_older_desired_state_without_a_receipt_boundary(){
        let (reliable,receiver)=mpsc::sync_channel(4);
        let output=Output{reliable,telemetry:Arc::new(Mutex::new(Telemetry{status:None,analysis:None,dropped:0})),sequence:0};
        let mut coordinator=Coordinator::new(output,Arc::new(Mutex::new(HashMap::new())),Arc::new(Mutex::new(VecDeque::new())));
        let request=|id:&str,detail:bool|{let mut context=Context::host(Some("engine".into()),Some(ProjectRef{project:"project".into(),epoch:"epoch".into()}));context.request_id=id.into();PrivateRequest{context,command:"setAnalysisSubscription".into(),args:json!({"ref":null,"subscription":{"detail":detail}})}};
        let old=request("old",false);coordinator.pending.insert(old.context.request_id.clone(),old.context.clone());
        coordinator.control(old).unwrap();coordinator.control(request("latest",true)).unwrap();
        assert_eq!(receiver.recv().unwrap()["failure"]["operation"]["outcome"],"superseded");
        assert_eq!(coordinator.desired_analysis.as_ref().unwrap().context.request_id,"latest");
        coordinator.source.shutdown();
    }
    #[test]
    fn same_project_configuration_cannot_clear_imported_preview_freeze(){
        let (reliable,_receiver)=mpsc::sync_channel(4);
        let output=Output{reliable,telemetry:Arc::new(Mutex::new(Telemetry{status:None,analysis:None,dropped:0})),sequence:0};
        let mut coordinator=Coordinator::new(output,Arc::new(Mutex::new(HashMap::new())),Arc::new(Mutex::new(VecDeque::new())));
        let context=Context::host(Some("engine".into()),Some(ProjectRef{project:"project".into(),epoch:"epoch".into()}));
        let configuration=PrivateRequest{context:context.clone(),command:"configureProject".into(),args:json!({"project":context.project,"trustedRead":true,"readBindings":[]})};
        coordinator.dispatch(configuration.clone()).unwrap();
        coordinator.dispatch(PrivateRequest{context:context.clone(),command:"preparePreview".into(),args:json!({})}).unwrap();
        coordinator.dispatch(configuration.clone()).unwrap();assert!(coordinator.preview_frozen);
        assert_eq!(coordinator.dispatch(PrivateRequest{context:context.clone(),command:"checkEntries".into(),args:json!({})}).unwrap_err().code,"trust_required");
        coordinator.dispatch(PrivateRequest{context:context.clone(),command:"resumeProject".into(),args:json!({})}).unwrap();assert!(!coordinator.preview_frozen);
        coordinator.preview_frozen=true;
        let mut replacement=configuration;replacement.args["project"]=json!({"project":"replacement","epoch":"other"});
        coordinator.dispatch(replacement).unwrap();assert!(!coordinator.preview_frozen);
        coordinator.source.shutdown();
    }
    #[test]
    fn imported_preview_rejects_score_mutation_before_queue_admission_but_keeps_global_controls(){
        let (reliable,_receiver)=mpsc::sync_channel(4);
        let output=Output{reliable,telemetry:Arc::new(Mutex::new(Telemetry{status:None,analysis:None,dropped:0})),sequence:0};
        let mut coordinator=Coordinator::new(output,Arc::new(Mutex::new(HashMap::new())),Arc::new(Mutex::new(VecDeque::new())));
        coordinator.preview_frozen=true;
        let request=|command:&str,kind:&str|PrivateRequest{
            context:Context::host(Some("engine".into()),Some(ProjectRef{project:"project".into(),epoch:"epoch".into()})),
            command:command.into(),args:json!({"ref":null,"command":{"kind":kind}})};
        for kind in ["seek","loop","restart"]{
            assert_eq!(coordinator.control(request("transport",kind)).unwrap_err().code,"trust_required");
        }
        assert_eq!(coordinator.control(request("setAudition","")).unwrap_err().code,"trust_required");
        assert!(coordinator.deferred.is_empty());assert!(coordinator.desired_audition.is_none());
        for kind in ["play","pause","stop","panic"]{coordinator.control(request("transport",kind)).unwrap();}
        coordinator.control(request("setAnalysisSubscription","")).unwrap();
        assert_eq!(coordinator.deferred.len(),4);assert!(coordinator.desired_analysis.is_some());
        coordinator.preview_frozen=false;
        coordinator.control(request("transport","seek")).unwrap();
        coordinator.control(request("setAudition","")).unwrap();
        assert_eq!(coordinator.deferred.len(),5);assert!(coordinator.desired_audition.is_some());
        coordinator.source.shutdown();
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
