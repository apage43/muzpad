use crate::protocol::{self, Context, Failure, PrivateRequest};
use serde_json::{Value,json};
use parking_lot::Mutex;
use std::{collections::{HashMap,VecDeque}, fs::File, io::Read, os::{fd::{FromRawFd,OwnedFd,AsRawFd},unix::process::CommandExt}, path::PathBuf, process::{Child,Command,Stdio}, sync::{Arc,atomic::{AtomicBool,Ordering},mpsc}, thread, time::{Duration,Instant}};

type Pending = HashMap<String,(Context,mpsc::Sender<Result<Value,Failure>>)>;
pub struct Supervisor {
    pub epoch: String,
    writer: mpsc::SyncSender<Vec<u8>>, child: Mutex<Option<Child>>, pending: Mutex<Pending>,
    stopped: AtomicBool, closing: AtomicBool, logs: Mutex<VecDeque<u8>>,
    callback: Arc<dyn Fn(Value)+Send+Sync>,
    cache:Mutex<Option<tempfile::TempDir>>,
    spawn_owner:Mutex<Option<mpsc::Sender<()>>>,
}
fn pipe()->std::io::Result<(OwnedFd,OwnedFd)>{
    let mut fds=[0;2];if unsafe{libc::pipe2(fds.as_mut_ptr(),libc::O_CLOEXEC)}!=0{return Err(std::io::Error::last_os_error());}
    Ok(unsafe{(OwnedFd::from_raw_fd(fds[0]),OwnedFd::from_raw_fd(fds[1]))})
}
fn elevated(fd:&OwnedFd)->std::io::Result<OwnedFd>{let raw=unsafe{libc::fcntl(fd.as_raw_fd(),libc::F_DUPFD_CLOEXEC,10)};if raw<0{Err(std::io::Error::last_os_error())}else{Ok(unsafe{OwnedFd::from_raw_fd(raw)})}}
impl Supervisor {
    pub fn spawn(executable:PathBuf,cache_root:&std::path::Path,callback:Arc<dyn Fn(Value)+Send+Sync>)->Result<Arc<Self>,Failure>{
        let (read_child,write_parent)=pipe()?;let (read_parent,write_child)=pipe()?;
        let read_child=elevated(&read_child)?;let write_child=elevated(&write_child)?;
        let r=read_child.as_raw_fd();let w=write_child.as_raw_fd();
        let epoch=uuid::Uuid::new_v4().to_string();
        let cache=tempfile::Builder::new().prefix("engine-").tempdir_in(cache_root)?;
        let mut command=Command::new(executable);
        command.env("MUZPAD_PROTOCOL_READ_FD","3").env("MUZPAD_PROTOCOL_WRITE_FD","4").env("MUZPAD_ENGINE_EPOCH",&epoch).env("MUZPAD_ENGINE_CACHE_DIR",cache.path())
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        unsafe{command.pre_exec(move||{
            if libc::setpgid(0,0)<0||libc::prctl(libc::PR_SET_PDEATHSIG,libc::SIGKILL)<0||libc::dup2(r,3)<0||libc::dup2(w,4)<0{return Err(std::io::Error::last_os_error());}
            if libc::getppid()==1{return Err(std::io::Error::other("Application parent exited during spawn"));}
            Ok(())
        });}
        // Linux PDEATHSIG follows the spawning thread. Tauri request workers may
        // retire while the application stays alive, so keep this owner until reap.
        let (spawned_tx,spawned_rx)=mpsc::sync_channel(1);
        let (spawn_owner,keep_owner)=mpsc::channel();
        thread::Builder::new().name("muzpad-engine-spawn-owner".into()).spawn(move||{
            match spawned_tx.send(command.spawn()) {
                Ok(())=>{let _=keep_owner.recv();},
                Err(error)=>{if let Ok(mut child)=error.0 {terminate_group(&mut child);}},
            }
        })?;
        let mut child=spawned_rx.recv().map_err(|e|Failure::new("child_died","engine",format!("Native spawn owner exited: {e}")))?
            .map_err(|e|Failure::new("child_died","engine",format!("Cannot start bundled native engine: {e}")))?;
        drop(read_child);drop(write_child);
        let stdout=child.stdout.take();let stderr=child.stderr.take();
        let (writer,frames)=mpsc::sync_channel(68);
        let supervisor=Arc::new(Self{epoch,writer,child:Mutex::new(Some(child)),pending:Mutex::new(HashMap::new()),stopped:AtomicBool::new(false),closing:AtomicBool::new(false),logs:Mutex::new(VecDeque::new()),callback,cache:Mutex::new(Some(cache)),spawn_owner:Mutex::new(Some(spawn_owner))});
        let owner=Arc::downgrade(&supervisor);
        thread::Builder::new().name("muzpad-engine-writer".into()).spawn(move||{
            let mut writer=File::from(write_parent);
            while let Ok(frame)=frames.recv(){
                if let Err(error)=protocol::write_encoded_frame(&mut writer,&frame){
                    if let Some(owner)=owner.upgrade(){owner.fail(Failure::new("child_died","engine",error.to_string()).lost());}
                    break;
                }
            }
        }).map_err(|error|{supervisor.fail(Failure::new("child_died","engine",error.to_string()).lost());Failure::from(error)})?;
        if let Some(stdout)=stdout{Self::capture_logs(&supervisor,stdout);}if let Some(stderr)=stderr{Self::capture_logs(&supervisor,stderr);}
        let owner=supervisor.clone();
        thread::Builder::new().name("muzpad-engine-reader".into()).spawn(move||{
            let mut reader=File::from(read_parent);
            let mut transfers=protocol::FrameTransfers::default();
            let failure=loop{match protocol::read_frame(&mut reader){
                Ok(Some(value))=>{
                    let value=match transfers.receive(value){Ok(Some(value))=>value,Ok(None)=>continue,Err(failure)=>break failure.lost()};
                    if value.get("protocolVersion").and_then(Value::as_u64)!=Some(protocol::VERSION as u64)
                        || value.get("engineEpoch").and_then(Value::as_str)!=Some(owner.epoch.as_str()){
                        break Failure::new("protocol_mismatch","engine","Native engine sent an invalid protocol or epoch").lost();
                    }
                    if value.get("event").is_some(){(owner.callback)(value);continue;}
                    let Some(id)=value.get("requestId").and_then(Value::as_str)else{break Failure::new("protocol_mismatch","engine","Native reply has no request identity").lost();};
                    if let Some((context,tx))=owner.pending.lock().remove(id){
                        let echoed=serde_json::from_value::<Context>(value.clone());
                        let result=if echoed.as_ref().ok()!=Some(&context){Err(Failure::new("protocol_mismatch","engine","Native reply context mismatch").lost())}
                        else if value.get("ok")==Some(&Value::Bool(true)){value.get("value").cloned().ok_or_else(||Failure::new("protocol_mismatch","engine","Native success missing value"))}
                        else{Err(value.get("failure").cloned().and_then(|v|serde_json::from_value(v).ok()).unwrap_or_else(||Failure::new("protocol_mismatch","engine","Malformed native failure")))};
                        let _=tx.send(result);
                    }
                },Ok(None)=>break Failure::new("child_died","engine","Native engine exited; unsaved source remains available").lost(),
                Err(e)=>break Failure::new("protocol_mismatch","engine",format!("Native protocol disconnected: {e}")).lost(),
            }};
            owner.fail(failure);
        }).map_err(|error|{supervisor.fail(Failure::new("child_died","engine",error.to_string()).lost());Failure::from(error)})?;
        Ok(supervisor)
    }
    fn capture_logs(owner:&Arc<Self>,mut stream:impl Read+Send+'static){let owner=Arc::downgrade(owner);thread::spawn(move||{
        let mut bytes=[0;4096];loop{let n=match stream.read(&mut bytes){Ok(0)|Err(_)=>break,Ok(n)=>n};let Some(owner)=owner.upgrade()else{break};
            let mut log=owner.logs.lock();for b in &bytes[..n]{if log.len()==65536{log.pop_front();}log.push_back(*b);}
        }
    });}
    fn fail(&self,mut failure:Failure){
        if self.stopped.swap(true,Ordering::AcqRel){return;}
        if !self.closing.load(Ordering::Acquire){
            let logs=self.logs.lock();
            let bytes:Vec<_>=logs.iter().skip(logs.len().saturating_sub(4096)).copied().collect();
            let text:String=String::from_utf8_lossy(&bytes).chars().filter(|c|!c.is_control()||matches!(*c,'\n'|'\t')).collect();
            if !text.trim().is_empty(){failure.help.get_or_insert_with(Vec::new).push(format!("Last native engine diagnostics:\n{text}"));}
        }
        for (_,(_,tx)) in self.pending.lock().drain(){let _=tx.send(Err(failure.clone()));}
        if let Some(mut child)=self.child.lock().take(){terminate_group(&mut child);}
        self.spawn_owner.lock().take();
        self.cache.lock().take();
        let context=Context::host(Some(self.epoch.clone()),None);
        (self.callback)(protocol::event(&context,0,"runtime",json!({"kind":"engine","state":if self.closing.load(Ordering::Acquire){"stopped"}else{"failed"},"engineEpoch":self.epoch,"capabilities":protocol::capabilities(&self.epoch),"failure":if self.closing.load(Ordering::Acquire){Value::Null}else{json!(failure)}})));
    }
    pub fn is_alive(&self)->bool{!self.stopped.load(Ordering::Acquire)}
    #[cfg(test)]
    pub(crate) fn crash_for_test(&self){
        let pid=self.child.lock().as_ref().unwrap().id() as libc::pid_t;
        assert_eq!(unsafe{libc::kill(pid,libc::SIGKILL)},0);
    }
    pub fn request(&self,context:&Context,command:&str,args:Value)->Result<Value,Failure>{self.request_timeout(context,command,args,None)}
    pub fn request_timeout(&self,context:&Context,command:&str,args:Value,timeout:Option<Duration>)->Result<Value,Failure>{
        let deadline=timeout.map(|timeout|Instant::now()+timeout);
        if !self.is_alive(){return Err(Failure::new("child_died","engine","Restart the native engine before retrying").lost());}
        if context.engine_epoch.as_deref()!=Some(self.epoch.as_str()){return Err(Failure::new("stale_request","engine","Request targets a previous engine"));}
        let (tx,rx)=mpsc::channel();{
            let mut pending=self.pending.lock();
            if !self.is_alive() || (self.closing.load(Ordering::Acquire) && command!="shutdown"){
                return Err(Failure::new("child_died","engine","The native engine is shutting down; restart explicitly").lost());
            }
            let limit=if matches!(command,"cancel"|"cancelExport"|"authorizeApply"|"shutdown"){68}else{64};
            if pending.len()>=limit{return Err(Failure::new("queue_full","engine","Native request limit reached"));}
            if pending.contains_key(&context.request_id){return Err(Failure::new("stale_request","engine","Duplicate native request identity"));}
            pending.insert(context.request_id.clone(),(context.clone(),tx));
        }
        let value=json!(PrivateRequest{context:context.clone(),command:command.into(),args});
        if let Err(failure)=protocol::send_frames(value,|frame|{
            let bytes=serde_json::to_vec(&frame).map_err(|e|Failure::new("protocol_mismatch","engine",e.to_string()))?;
            if let Some(deadline)=deadline {
                let mut bytes=bytes;
                loop {
                    if !self.is_alive(){return Err(Failure::new("child_died","engine","Native engine stopped during request admission").lost());}
                    if Instant::now()>=deadline{return Err(Failure::new("child_died","engine","Native operation did not finish before its deadline").lost());}
                    match self.writer.try_send(bytes) {
                        Ok(())=>break Ok(()),
                        Err(mpsc::TrySendError::Disconnected(_))=>break Err(Failure::new("child_died","engine","Native request channel unavailable").lost()),
                        Err(mpsc::TrySendError::Full(frame))=>{
                            bytes=frame;
                            thread::sleep(deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(1)));
                        }
                    }
                }
            } else {
                self.writer.send(bytes).map_err(|e|Failure::new("child_died","engine",format!("Native request channel unavailable: {e}")).lost())
            }
        }) {
            self.pending.lock().remove(&context.request_id);return Err(failure);
        }
        let result=match deadline{Some(deadline)=>rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).map_err(|_|Failure::new("child_died","engine","Native operation did not finish before its deadline").lost()),None=>rx.recv().map_err(|_|Failure::new("child_died","engine","Native reply channel closed").lost())};
        self.pending.lock().remove(&context.request_id);result?
    }
    pub fn shutdown(&self){
        if self.closing.swap(true,Ordering::AcqRel){return;}
        if self.is_alive(){let context=Context::host(Some(self.epoch.clone()),None);let _=self.request_timeout(&context,"shutdown",json!({}),Some(Duration::from_secs(3)));}
        let deadline=Instant::now()+Duration::from_secs(2);
        loop{
            let mut slot=self.child.lock();let Some(child)=slot.as_mut()else{break;};
            if child.try_wait().ok().flatten().is_some(){slot.take();break;}
            if Instant::now()>=deadline{terminate_group(child);slot.take();break;}
            drop(slot);thread::sleep(Duration::from_millis(20));
        }
        self.fail(Failure::new("child_died","engine","Native engine shut down").lost());
    }
}

fn terminate_group(child:&mut Child){
    // The fixed engine is its own process-group leader; its render children share that group.
    unsafe{libc::kill(-(child.id() as libc::pid_t),libc::SIGKILL);}
    let _=child.kill();let _=child.wait();
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn abrupt_process_exit_is_observed_and_reaped(){
        // Process-lifecycle fixture only; this does not exercise native audio.
        let (tx,rx)=mpsc::channel();
        let cache=tempfile::tempdir().unwrap();
        let owner=Supervisor::spawn(PathBuf::from("/bin/true"),cache.path(),Arc::new(move|event|{let _=tx.send(event);})).unwrap();
        let event=rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(event["event"]["value"]["state"],"failed");
        let context=Context::host(Some(owner.epoch.clone()),None);
        assert_eq!(owner.request(&context,"hello",json!({})).unwrap_err().code,"child_died");
        assert!(owner.child.lock().is_none());
        owner.shutdown();
    }
    #[test]
    fn protocol_pipe_is_independent_of_log_bytes(){
        use std::io::Write;
        let (read,write)=pipe().unwrap();
        let mut reader=File::from(read);let mut writer=File::from(write);
        let (log_read,log_write)=pipe().unwrap();
        let mut logs=File::from(log_read);let mut plugin_stdout=File::from(log_write);
        plugin_stdout.write_all(b"unframed plugin output").unwrap();drop(plugin_stdout);
        protocol::write_frame(&mut writer,&json!({"protocolVersion":1})).unwrap();drop(writer);
        assert_eq!(protocol::read_frame(&mut reader).unwrap(),Some(json!({"protocolVersion":1})));
        assert!(protocol::read_frame(&mut reader).unwrap().is_none());
        let mut bytes=Vec::new();logs.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes,b"unframed plugin output");
    }
    #[test]
    fn real_child_formats_large_document_and_echoes_buffer_version(){
        let executable=std::env::var_os("MUZPAD_TEST_ENGINE").map(PathBuf::from)
            .unwrap_or_else(||PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/release/muzpad-engine"));
        let cache=tempfile::tempdir().unwrap();
        let owner=Supervisor::spawn(executable,cache.path(),Arc::new(|_|{})).unwrap();
        let mut context=Context::host(Some(owner.epoch.clone()),None);
        owner.request(&context,"hello",json!({"coreRevision":env!("MUZPAD_CORE_REVISION"),"limits":protocol::limits()})).unwrap();
        context.request_id=uuid::Uuid::new_v4().to_string();
        let source=format!("// {}\nlet a=1;\n","λ".repeat(protocol::FRAME_BYTES));
        let result=owner.request_timeout(&context,"format",json!({"source":source,"path":"main.muz","bufferVersion":42}),Some(Duration::from_secs(30))).unwrap();
        assert_eq!(result["bufferVersion"],42);
        assert_eq!(result["source"],muz::lang::format::format(&source).unwrap());
        assert!(result["source"].as_str().unwrap().len()>protocol::FRAME_BYTES);
        owner.shutdown();assert!(owner.child.lock().is_none());
    }
    #[test]
    fn real_child_survives_short_lived_spawn_caller_thread(){
        let executable=std::env::var_os("MUZPAD_TEST_ENGINE").map(PathBuf::from)
            .unwrap_or_else(||PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/release/muzpad-engine"));
        let cache=tempfile::tempdir().unwrap();let root=cache.path().to_owned();
        let owner=thread::spawn(move||Supervisor::spawn(executable,&root,Arc::new(|_|{})).unwrap()).join().unwrap();
        // The spawning API caller has exited before this real private handshake.
        let context=Context::host(Some(owner.epoch.clone()),None);
        let hello=owner.request_timeout(&context,"hello",json!({"coreRevision":env!("MUZPAD_CORE_REVISION"),"limits":protocol::limits()}),Some(Duration::from_secs(5))).unwrap();
        assert_eq!(hello["protocolVersion"],protocol::VERSION);
        assert!(owner.is_alive());
        owner.shutdown();assert!(owner.child.lock().is_none());assert!(owner.spawn_owner.lock().is_none());
    }
    #[test]
    fn real_child_checks_first_untitled_capture_without_phantom_source_version(){
        use crate::project::ProjectService;
        use base64::{Engine,engine::general_purpose::STANDARD};
        let directory=tempfile::tempdir().unwrap();
        let mut service=ProjectService::new(directory.path().join("data"),directory.path().join("config"),directory.path().join("resources"),Arc::new(|_|{})).unwrap();
        let mut context=Context::host(None,None);
        let project=service.dispatch("project.newProject",json!({"settings":{"title":"Untitled","entry":"song.muz"}}),&context).unwrap();
        let reference=protocol::ProjectRef{project:project["project"].as_str().unwrap().into(),epoch:project["epoch"].as_str().unwrap().into()};
        context.project=Some(reference.clone());context.source_version=project["sourceVersion"].as_u64();
        let input=json!({
            "project":reference.project,"epoch":reference.epoch,"sourceVersion":project["sourceVersion"],
            "entry":"song.muz","expectedDiskGeneration":project["diskGeneration"],
            "buffers":[{"fileId":project["files"][0]["id"],"path":"song.muz","text":"",
                "bufferVersion":project["files"][0]["bufferVersion"],"expectedDiskVersion":null}],
            "settings":{"title":"Untitled","entry":"song.muz","entries":["song.muz"]},"settingsDiskVersion":null
        });
        let snapshot=service.dispatch("project.snapshotSources",json!({"input":input}),&context).unwrap();
        assert_eq!(snapshot["sourceVersion"],project["sourceVersion"]);
        let (descriptor,files)=service.snapshot_transfer(snapshot["id"].as_str().unwrap()).unwrap();
        let executable=std::env::var_os("MUZPAD_TEST_ENGINE").map(PathBuf::from)
            .unwrap_or_else(||PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/release/muzpad-engine"));
        let cache=tempfile::tempdir().unwrap();
        let owner=Supervisor::spawn(executable,cache.path(),Arc::new(|_|{})).unwrap();
        context.engine_epoch=Some(owner.epoch.clone());
        let mut request=|command:&str,args:Value|{
            context.request_id=uuid::Uuid::new_v4().to_string();
            owner.request_timeout(&context,command,args,Some(Duration::from_secs(10))).unwrap()
        };
        request("hello",json!({"coreRevision":env!("MUZPAD_CORE_REVISION"),"limits":protocol::limits()}));
        request("configureProject",json!({"project":reference,"readGrants":service.read_grants()}));
        let descriptors:Vec<_>=files.iter().map(|(file,text)|{
            let mut file=file.clone();file["bytes"]=json!(text.len());file
        }).collect();
        request("snapshotBegin",json!({"snapshot":descriptor,"files":descriptors}));
        for (file,text) in files {
            for (index,chunk) in text.as_bytes().chunks(protocol::CHUNK_BYTES).enumerate(){
                request("snapshotChunk",json!({"snapshot":snapshot["id"],"fileId":file["fileId"],"index":index,"data":STANDARD.encode(chunk)}));
            }
        }
        request("snapshotFinish",json!({"snapshot":snapshot["id"]}));
        let checked=request("checkEntries",json!({"snapshot":snapshot["id"],"entries":["song.muz"]}));
        assert_eq!(checked["sourceVersion"],project["sourceVersion"]);
        assert_eq!(checked["entries"][0]["playable"],false);
        assert_eq!(checked["entries"][0]["failure"]["code"],"invalid_source");
        owner.shutdown();assert!(owner.child.lock().is_none());
        service.shutdown().unwrap();
    }
    #[test]
    fn real_child_forced_hang_shutdown_is_bounded_and_reaped(){
        let executable=std::env::var_os("MUZPAD_TEST_ENGINE").map(PathBuf::from)
            .unwrap_or_else(||PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/release/muzpad-engine"));
        let cache=tempfile::tempdir().unwrap();
        let owner=Supervisor::spawn(executable,cache.path(),Arc::new(|_|{})).unwrap();
        let context=Context::host(Some(owner.epoch.clone()),None);
        owner.request_timeout(&context,"hello",json!({"coreRevision":env!("MUZPAD_CORE_REVISION"),"limits":protocol::limits()}),Some(Duration::from_secs(5))).unwrap();
        let pid=owner.child.lock().as_ref().unwrap().id() as libc::pid_t;
        assert_eq!(unsafe{libc::kill(pid,libc::SIGSTOP)},0);
        let started=Instant::now();owner.shutdown();
        assert!(started.elapsed()<Duration::from_secs(10));
        assert!(!owner.is_alive());
        assert!(owner.child.lock().is_none());assert!(owner.spawn_owner.lock().is_none());
        assert_eq!(unsafe{libc::kill(pid,0)},-1);
    }
    #[test]
    fn real_child_writer_pressure_shutdown_deadline_reaps_and_releases_requests(){
        let executable=std::env::var_os("MUZPAD_TEST_ENGINE").map(PathBuf::from)
            .unwrap_or_else(||PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/release/muzpad-engine"));
        let cache=tempfile::tempdir().unwrap();
        let owner=Supervisor::spawn(executable,cache.path(),Arc::new(|_|{})).unwrap();
        let context=Context::host(Some(owner.epoch.clone()),None);
        owner.request_timeout(&context,"hello",json!({"coreRevision":env!("MUZPAD_CORE_REVISION"),"limits":protocol::limits()}),Some(Duration::from_secs(5))).unwrap();
        let pid=owner.child.lock().as_ref().unwrap().id() as libc::pid_t;
        assert_eq!(unsafe{libc::kill(pid,libc::SIGSTOP)},0);
        let callers:(Vec<_>,Vec<_>)=(0..4).map(|_|{
            let owner=owner.clone();let (tx,rx)=mpsc::channel();
            let caller=thread::spawn(move||{
                let context=Context::host(Some(owner.epoch.clone()),None);
                let source=format!("// {}\nlet a=1;\n","x".repeat(protocol::SOURCE_DOCUMENT_BYTES-32));
                tx.send(owner.request(&context,"format",json!({"source":source,"path":"main.muz","bufferVersion":1}))).unwrap();
            });
            (caller,rx)
        }).unzip();
        let queued_deadline=Instant::now()+Duration::from_secs(5);
        loop{
            let context=Context::host(Some(owner.epoch.clone()),None);
            let probe=serde_json::to_vec(&PrivateRequest{context,command:"hello".into(),args:json!({"coreRevision":env!("MUZPAD_CORE_REVISION"),"limits":protocol::limits()})}).unwrap();
            match owner.writer.try_send(probe){
                Err(mpsc::TrySendError::Full(_))=>break,
                Ok(())=>thread::sleep(Duration::from_millis(5)),
                Err(mpsc::TrySendError::Disconnected(_))=>panic!("writer disconnected before shutdown"),
            }
            assert!(Instant::now()<queued_deadline,"writer pressure did not fill its bounded queue");
        }
        let started=Instant::now();owner.shutdown();
        assert!(started.elapsed()<Duration::from_secs(8));
        for reply in callers.1 {assert_eq!(reply.recv_timeout(Duration::from_secs(2)).unwrap().unwrap_err().code,"child_died");}
        for caller in callers.0 {caller.join().unwrap();}
        assert!(owner.pending.lock().is_empty());assert!(!owner.is_alive());
        assert!(owner.child.lock().is_none());assert!(owner.spawn_owner.lock().is_none());
        assert_eq!(unsafe{libc::kill(pid,0)},-1);
    }
}
