use super::*;

fn service() -> (tempfile::TempDir, ProjectService) {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data"); let config = dir.path().join("config"); let resources = dir.path().join("resources");
    std::fs::create_dir_all(&data).unwrap(); std::fs::create_dir_all(&config).unwrap(); std::fs::create_dir_all(resources.join("library/contrib/test")).unwrap();
    let service = ProjectService::new(data,config,resources,Arc::new(|_|{})).unwrap();
    (dir,service)
}
fn settings() -> Settings { Settings { title:"Test project".into(),entry:"main.muz".into(),entries:None } }
fn start(service: &mut ProjectService) {
    let context = Context::host(None,None);
    service.dispatch("project.newProject",json!({"settings":settings()}),&context).unwrap();
    service.watcher.stop();
}
fn capture(service: &ProjectService) -> WorkingCapture { service.state.lock().as_ref().unwrap().working_capture() }
fn change(mut capture: WorkingCapture, text: &str) -> WorkingCapture { capture.source_version += 1; capture.buffers[0].buffer_version += 1; capture.buffers[0].text = Some(text.into()); capture }
fn restore_recovery(service: &mut ProjectService, input: Value) -> Result<Value, Failure> {
    let context = Context::host(None,service.current_ref());
    service.dispatch("project.restoreRecovery",json!({"input":input}),&context)
}
fn permit_replacement(service: &mut ProjectService) {
    let permitted=service.prepare_close(&json!({"capture":capture(service),"reason":"replaceProject","decision":"discard","ticket":null}),0).unwrap();
    let reference=service.current_ref().unwrap();
    service.close(&json!({"project":reference.project,"epoch":reference.epoch,"token":permitted["token"]})).unwrap();
}

#[test]
fn service_is_send_and_plain_data_never_contains_runtime_handles() { fn require_send<T: Send>() {} require_send::<ProjectService>(); }

#[test]
fn native_default_root_prefers_song_then_main_then_lexical_without_evaluating() {
    for (paths,expected) in [
        (vec!["z.muz","main.muz","song.muz"],"song.muz"),
        (vec!["a.muz","main.muz","nested/song.muz"],"main.muz"),
        (vec!["z.muz","nested/a.muz","b.muz"],"b.muz"),
    ] {
        let (dir,mut service)=service();let root=dir.path().join("root");std::fs::create_dir(&root).unwrap();
        for path in paths{let file=root.join(path);std::fs::create_dir_all(file.parent().unwrap()).unwrap();std::fs::write(file,"not evaluated to choose an entry").unwrap();}
        let opened=service.open_folder(root,None).unwrap();service.watcher.stop();
        assert_eq!(opened["entry"],expected);assert_eq!(opened["execution"]["policy"],"account-native");
    }
}

#[test]
fn imported_preview_preserves_previous_dirty_buffers_snapshot_and_parent_trust_on_cancel() {
    let (dir,mut service)=service();start(&mut service);
    let dirty=change(capture(&service),"trusted dirty draft");service.acknowledge(&dirty).unwrap();
    let before=service.current().unwrap();let accepted=service.capture_sources(capture(&service)).unwrap();
    let id=accepted["id"].as_str().unwrap();service.retain_accepted_snapshot(id).unwrap();
    let permitted=service.prepare_close(&json!({"capture":capture(&service),"reason":"replaceProject","decision":"discard","ticket":null}),0).unwrap();
    let reference=service.current_ref().unwrap();service.close(&json!({"project":reference.project,"epoch":reference.epoch,"token":permitted["token"]})).unwrap();
    let preview=service.import_project(json!({"kind":"content","project":{"settings":settings(),"files":[{"path":"main.muz","text":"untrusted preview"}],"assets":[]}})).unwrap();
    service.watcher.stop();assert_eq!(preview["execution"]["policy"],"preview");assert_eq!(service.require_trusted().unwrap_err().code,"trust_required");
    let external=dir.path().join("outside.muz");std::fs::write(&external,"external module").unwrap();
    assert_eq!(service.library_document(&json!({"project":service.current_ref(),"id":external})).unwrap_err().code,"trust_required");
    assert_eq!(service.snapshot_transfer(id).unwrap().1[0].1,"trusted dirty draft");
    let recovery=operations::recovery_record(service.state.lock().as_ref().unwrap());assert_eq!(recovery["trusted"],false);
    let restored=service.restore_preview().unwrap().unwrap();assert_eq!(restored,before);
    assert_eq!(service.retained_snapshot().as_deref(),Some(id));assert!(service.trusted_read());
}
#[cfg(unix)]
#[test]
fn preview_cancel_reconciles_consumed_dependencies_and_same_content_link_retargets(){
    use std::os::unix::fs::symlink;
    for retarget in [false,true]{
        let (dir,mut service)=service();start(&mut service);
        let first=dir.path().join("external-one.muz");let second=dir.path().join("external-two.muz");let alias=dir.path().join("external-link.muz");
        std::fs::write(&first,"external source").unwrap();std::fs::write(&second,"external source").unwrap();symlink(&first,&alias).unwrap();
        let descriptor=service.capture_sources(capture(&service)).unwrap();
        let dependencies=json!([{"grant":"account-native","path":alias,"canonical":first,"version":digest(b"external source")}]);
        service.validate_snapshot(descriptor["id"].as_str().unwrap(),&dependencies).unwrap();
        service.retain_accepted_snapshot(descriptor["id"].as_str().unwrap()).unwrap();
        let before=service.current().unwrap();permit_replacement(&mut service);
        service.import_project(json!({"kind":"content","project":{"settings":settings(),"files":[{"path":"main.muz","text":"preview"}],"assets":[]}})).unwrap();
        if retarget{std::fs::remove_file(&alias).unwrap();symlink(&second,&alias).unwrap();}
        else{std::fs::write(&first,"changed external source").unwrap();}
        let restored=service.restore_preview().unwrap().unwrap();
        assert_eq!(restored["project"],before["project"]);assert!(service.trusted_read());
        assert_eq!(restored["sourceVersion"].as_u64().unwrap(),before["sourceVersion"].as_u64().unwrap()+1);
        assert_eq!(service.validate_retained_snapshot(descriptor["id"].as_str().unwrap(),&dependencies).unwrap_err().code,"source_conflict");
    }
}
#[cfg(unix)]
#[test]
fn preview_cancel_invalidates_a_dependency_replaced_with_fifo_without_blocking(){
    use std::{ffi::CString,os::unix::ffi::OsStrExt,time::{Duration,Instant}};
    let (dir,mut service)=service();start(&mut service);
    let path=dir.path().join("external.muz");std::fs::write(&path,"external source").unwrap();
    let descriptor=service.capture_sources(capture(&service)).unwrap();
    service.validate_snapshot(descriptor["id"].as_str().unwrap(),&json!([{"grant":"account-native","path":path,"canonical":path,"version":digest(b"external source")}])).unwrap();
    let before=service.current().unwrap();permit_replacement(&mut service);
    service.import_project(json!({"kind":"content","project":{"settings":settings(),"files":[{"path":"main.muz","text":"preview"}],"assets":[]}})).unwrap();
    std::fs::remove_file(&path).unwrap();let name=CString::new(path.as_os_str().as_bytes()).unwrap();assert_eq!(unsafe{libc::mkfifo(name.as_ptr(),0o600)},0);
    let started=Instant::now();let restored=service.restore_preview().unwrap().unwrap();
    assert!(started.elapsed()<Duration::from_secs(1));assert!(service.trusted_read());
    assert_eq!(restored["sourceVersion"].as_u64().unwrap(),before["sourceVersion"].as_u64().unwrap()+1);
}
#[test]
fn untrusted_recovery_is_staged_without_publishing_or_replacing_current_authority(){
    let (_dir,mut service)=service();start(&mut service);
    let mut recovered=service.unsaved(settings(),None).unwrap();recovered.trusted=false;
    let record=operations::recovery_record(&recovered);service.storage.put_recovery(&record).unwrap();
    let before=service.current().unwrap();let descriptor=service.capture_sources(capture(&service)).unwrap();
    permit_replacement(&mut service);
    assert!(service.stage_recovery(&json!({"id":record["id"],"action":"restore"})).unwrap());
    assert_eq!(service.current().unwrap(),before);assert!(service.trusted_read());
    assert!(service.snapshot_transfer(descriptor["id"].as_str().unwrap()).is_ok());
    let preview=service.install_staged_project().unwrap();assert_eq!(preview["execution"]["policy"],"preview");
    assert_eq!(service.preview_project().unwrap().project,before["project"].as_str().unwrap());
    assert_eq!(service.restore_preview().unwrap().unwrap(),before);
}

#[test]
fn captures_include_closed_new_and_deleted_buffers_and_reject_older_text() {
    let (_dir,mut service) = service(); start(&mut service);
    let old = capture(&service); let mut next = change(old.clone(),"local");
    next.buffers.push(Capture { file_id:"client-new".into(),path:"nested/closed.muz".into(),text:Some("closed buffer".into()),buffer_version:1,expected_disk_version:None });
    service.acknowledge(&next).unwrap();
    assert_eq!(service.acknowledge(&old).unwrap_err().code,"stale_request");
    let mut omitted = capture(&service); omitted.source_version += 1; omitted.buffers.pop();
    assert_eq!(service.acknowledge(&omitted).unwrap_err().code,"invalid_source");
    let mut deleted = capture(&service); deleted.source_version += 1;
    let file = deleted.buffers.iter_mut().find(|f| f.path == "nested/closed.muz").unwrap(); file.text = None; file.buffer_version += 1;
    service.acknowledge(&deleted).unwrap();
    assert!(service.current().unwrap()["files"].as_array().unwrap().iter().any(|f|f["deleted"] == true));
}

#[test]
fn immutable_snapshot_keeps_dirty_bytes_and_gate_rejects_disk_race() {
    let (dir,mut service) = service();
    let root = dir.path().join("project"); std::fs::create_dir(&root).unwrap(); std::fs::write(root.join("main.muz"),"disk base").unwrap();
    std::fs::write(root.join(SETTINGS),settings().bytes().unwrap()).unwrap();
    service.open_folder(root.clone(),None).unwrap(); service.watcher.stop();
    let captured = change(capture(&service),"dirty local");
    let snapshot = service.capture_sources(captured.clone()).unwrap(); let id = snapshot["id"].as_str().unwrap();
    let (_,files) = service.snapshot_transfer(id).unwrap();
    assert_eq!(files.iter().find(|(f,_)|f["path"] == "main.muz").unwrap().1,"dirty local");
    let grant = project_grant(&captured.project);
    service.validate_snapshot(id,&json!([{"grant":grant,"path":"main.muz","version":digest(b"dirty local")}])).unwrap();
    std::fs::write(root.join("main.muz"),"external racing text").unwrap();
    assert_eq!(service.validate_snapshot(id,&json!([])).unwrap_err().code,"source_conflict");
    assert_eq!(service.snapshot_transfer(id).unwrap().1[0].1,files[0].1);
}

#[test]
fn demand_library_versions_are_pinned_and_accepted_snapshots_survive_candidates() {
    let (dir,mut service) = service(); start(&mut service);
    let library = dir.path().join("resources/library/contrib/test/module.muz"); std::fs::write(&library,"library one").unwrap();
    let first = service.capture_sources(capture(&service)).unwrap(); let first_id = first["id"].as_str().unwrap().to_owned();
    assert_eq!(service.snapshot_transfer(&first_id).unwrap().1.len(),1,"Unvisited library sources must not be captured");
    assert!(service.retained_snapshot().is_none()); service.retain_accepted_snapshot(&first_id).unwrap();
    for n in 0..7 { let next = change(capture(&service),&format!("candidate {n}")); service.capture_sources(next).unwrap(); }
    assert!(service.snapshot_transfer(&first_id).is_ok()); assert_eq!(service.retained_snapshot(),Some(first_id.clone()));
    std::fs::write(&library,"library two").unwrap();
    let current_id = service.snapshot_order.back().unwrap();
    service.validate_snapshot(current_id,&json!([])).unwrap();
    let checked=service.capture_sources(change(capture(&service),"consuming library")).unwrap();
    let current_id=checked["id"].as_str().unwrap();
    let dependency=json!([{"grant":"account-native","path":library,"canonical":library,"version":digest(b"library two")}]);
    service.validate_snapshot(current_id,&dependency).unwrap();
    std::fs::write(&library,"library three").unwrap();
    assert_eq!(service.validate_snapshot(current_id,&dependency).unwrap_err().code,"source_conflict");
}

#[test]
fn refresh_retains_local_base_and_external_versions_until_explicit_resolution() {
    let (dir,mut service) = service(); let root = dir.path().join("project"); std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("main.muz"),"base").unwrap(); std::fs::write(root.join(SETTINGS),settings().bytes().unwrap()).unwrap();
    service.open_folder(root.clone(),None).unwrap(); service.watcher.stop();
    service.acknowledge(&change(capture(&service),"local")).unwrap();
    std::fs::write(root.join("main.muz"),"disk").unwrap();
    { let mut current = service.state.lock(); rescan(current.as_mut().unwrap()).unwrap(); }
    let value = service.current().unwrap(); let conflict = &value["conflicts"][0];
    assert_eq!(conflict["base"],"base"); assert_eq!(conflict["local"],"local"); assert_eq!(conflict["disk"],"disk");
    let input = json!({"project":value["project"],"epoch":value["epoch"],"fileId":conflict["fileId"],"diskVersion":conflict["diskVersion"],"choice":"local"});
    let resolved = service.resolve_conflict(&input).unwrap(); assert_eq!(resolved["files"][0]["text"],"local"); assert_eq!(resolved["files"][0]["dirty"],true);
    assert_eq!(std::fs::read_to_string(root.join("main.muz")).unwrap(),"disk");
}

#[test]
fn durable_restore_preserves_a_newer_disk_as_conflict() {
    let (dir,mut service) = service(); let root = dir.path().join("project"); std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("main.muz"),"base").unwrap(); std::fs::write(root.join(SETTINGS),settings().bytes().unwrap()).unwrap();
    service.open_folder(root.clone(),None).unwrap(); service.watcher.stop();
    service.acknowledge(&change(capture(&service),"draft")).unwrap(); service.persist_current().unwrap();
    let id = service.current_ref().unwrap().project; *service.state.lock() = None;
    std::fs::write(root.join("main.muz"),"external").unwrap();
    let restored = restore_recovery(&mut service,json!({"id":id,"action":"restore"})).unwrap();
    assert_eq!(restored["conflicts"][0]["local"],"draft"); assert_eq!(restored["conflicts"][0]["disk"],"external");
}

#[test]
fn close_permits_are_one_use_version_bound_and_not_window_exit_for_replacement() {
    let (_dir,mut service) = service(); start(&mut service);
    let working = capture(&service);
    let approved = service.prepare_close(&json!({"capture":working,"reason":"replaceProject","decision":"discard","cancelExports":false,"ticket":null}),0).unwrap();
    let reference = service.current_ref().unwrap(); let close = json!({"project":reference.project,"epoch":reference.epoch,"token":approved["token"]});
    service.close(&close).unwrap(); assert!(service.current_ref().is_some()); assert!(!service.close_allowed()); assert!(service.close(&close).is_err());
    service.check_replacement().unwrap();
    service.acknowledge(&change(capture(&service),"newer typing")).unwrap();
    assert!(service.check_replacement().is_err());
}

#[test]
fn active_exports_and_stale_native_tickets_veto_close() {
    let (_dir,mut service) = service(); start(&mut service); service.set_close_ticket("ticket".into());
    let input = json!({"capture":capture(&service),"reason":"closeWindow","decision":"discard","cancelExports":false,"ticket":"ticket"});
    let denied = service.prepare_close(&input,1).unwrap(); assert_eq!(denied["allowed"],false); assert_eq!(denied["failure"]["code"],"queue_full");
    let permitted = service.prepare_close(&input,0).unwrap(); service.set_close_ticket("new-ticket".into());
    let reference = service.current_ref().unwrap(); assert!(service.close(&json!({"project":reference.project,"epoch":reference.epoch,"token":permitted["token"]})).is_err()); assert!(!service.close_allowed());
}

#[test]
fn newer_local_capture_after_clean_refresh_becomes_durable_three_way_conflict() {
    let (dir,mut service) = service(); let root = dir.path().join("race"); std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("main.muz"),"original base").unwrap(); std::fs::write(root.join(SETTINGS),settings().bytes().unwrap()).unwrap();
    service.open_folder(root.clone(),None).unwrap(); service.watcher.stop();
    let local = change(capture(&service),"newer unsent local text");
    std::fs::write(root.join("main.muz"),"external disk refresh").unwrap();
    { let mut state = service.state.lock(); rescan(state.as_mut().unwrap()).unwrap(); }
    service.acknowledge(&local).unwrap(); service.persist_current().unwrap();
    let snapshot = service.current().unwrap();
    assert_eq!(snapshot["conflicts"][0]["base"],"original base");
    assert_eq!(snapshot["conflicts"][0]["local"],"newer unsent local text");
    assert_eq!(snapshot["conflicts"][0]["disk"],"external disk refresh");
    assert_eq!(snapshot["files"][0]["text"],"newer unsent local text");
    let stored = service.storage.recovery_records().unwrap();
    assert_eq!(stored[0]["capture"]["buffers"][0]["text"],"newer unsent local text");
    assert_eq!(std::fs::read_to_string(root.join("main.muz")).unwrap(),"external disk refresh");
}

#[test]
fn accepted_restart_preserves_edits_but_rejects_changed_consumed_asset() {
    let (_dir,mut service) = service(); start(&mut service);
    let root = service.state.lock().as_ref().unwrap().root.path().to_owned();
    std::fs::write(root.join("sample.wav"),b"original asset").unwrap();
    { let mut state = service.state.lock(); rescan(state.as_mut().unwrap()).unwrap(); }
    let snapshot = service.capture_sources(capture(&service)).unwrap(); let id = snapshot["id"].as_str().unwrap();
    let grant = project_grant(&service.current_ref().unwrap().project);
    let dependency = json!([{"grant":grant,"path":"sample.wav","version":digest(b"original asset")}]);
    service.validate_snapshot(id,&dependency).unwrap(); service.retain_accepted_snapshot(id).unwrap();
    service.acknowledge(&change(capture(&service),"new working text")).unwrap();
    service.validate_retained_snapshot(id,&dependency).unwrap();
    std::fs::write(root.join("sample.wav"),b"replacement asset").unwrap();
    let changed = json!([{"grant":grant,"path":"sample.wav","version":digest(b"replacement asset")}]);
    assert_eq!(service.validate_retained_snapshot(id,&changed).unwrap_err().code,"changed_asset");
    assert_eq!(service.current().unwrap()["files"][0]["text"],"new working text");
}

#[test]
fn typing_during_own_save_advances_only_saved_baseline_without_false_external_conflict() {
    let (dir,mut service) = service(); let root = dir.path().join("own-save"); std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("main.muz"),"base").unwrap(); std::fs::write(root.join(SETTINGS),settings().bytes().unwrap()).unwrap();
    service.open_folder(root,None).unwrap(); service.watcher.stop();
    let saved_capture = change(capture(&service),"saved version");
    let input = SaveInput { project:saved_capture.project.clone(),epoch:saved_capture.epoch.clone(),files:saved_capture.buffers.clone(),settings:saved_capture.settings.clone(),settings_disk_version:saved_capture.settings_disk_version.clone() };
    let saved = service.save(input,Some(saved_capture.source_version)).unwrap(); assert_eq!(saved["settingsSaved"],true);
    let newer = change(saved_capture,"newer typing");
    service.acknowledge(&newer).unwrap(); service.persist_current().unwrap();
    let snapshot = service.current().unwrap();
    assert!(snapshot["conflicts"].as_array().unwrap().is_empty());
    assert_eq!(snapshot["files"][0]["text"],"newer typing");
    assert_eq!(snapshot["files"][0]["diskVersion"],digest(b"saved version"));
    assert_eq!(snapshot["files"][0]["dirty"],true);
}

#[test]
fn first_save_preserves_external_library_and_copies_only_owned_assets() {
    let (dir,mut service) = service(); start(&mut service);
    let destination=dir.path().join("saved"); std::fs::create_dir(&destination).unwrap();
    let external=dir.path().join("external"); std::fs::create_dir(&external).unwrap();
    std::fs::write(external.join("module.muz"),"external source").unwrap();
    let linked=json!({"id":"external:test","path":external,"kind":"library","linked":true,"version":null,"byteLength":null,"availability":{"available":true,"reason":null}});
    {
        let mut state=service.state.lock();let workspace=state.as_mut().unwrap();
        workspace.resources.push(linked.clone());
        let version=workspace.root.write("sample.wav",Some(b"owned sample"),None,service.storage.journal_dir()).unwrap();
        let mut owned=resource(&workspace.project,"sample.wav",12,version,false);
        owned["pendingSave"]=json!(true);workspace.resources.push(owned);
        super::operations::adopt_save_destination(workspace,Arc::new(Root::open(&destination).unwrap())).unwrap();
    }
    let captured=change(capture(&service),"saved entry");
    let input=SaveInput{project:captured.project.clone(),epoch:captured.epoch.clone(),files:captured.buffers.clone(),settings:captured.settings.clone(),settings_disk_version:captured.settings_disk_version.clone()};
    let result=service.save(input,Some(captured.source_version)).unwrap();
    assert_eq!(result["settingsSaved"],true);
    assert!(result["failures"].as_array().unwrap().is_empty());
    assert_eq!(std::fs::read(destination.join("sample.wav")).unwrap(),b"owned sample");
    assert_eq!(std::fs::read_to_string(destination.join("main.muz")).unwrap(),"saved entry");
    assert_eq!(std::fs::read_to_string(external.join("module.muz")).unwrap(),"external source");
    assert!(service.current().unwrap()["resources"].as_array().unwrap().contains(&linked));
}

#[test]
fn malformed_external_settings_never_partially_publish_source_rescan() {
    let (dir,mut service)=service();let root=dir.path().join("atomic-rescan");std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("main.muz"),"original source").unwrap();
    std::fs::write(root.join(SETTINGS),settings().bytes().unwrap()).unwrap();
    service.open_folder(root.clone(),None).unwrap();service.watcher.stop();
    let before=service.current().unwrap();
    std::fs::write(root.join("main.muz"),"external source").unwrap();
    std::fs::write(root.join(SETTINGS),"{invalid metadata").unwrap();
    let error=rescan(service.state.lock().as_mut().unwrap()).unwrap_err();
    assert_eq!(error.code,"invalid_source");
    assert_eq!(service.current().unwrap(),before);
    std::fs::write(root.join(SETTINGS),settings().bytes().unwrap()).unwrap();
    assert!(rescan(service.state.lock().as_mut().unwrap()).unwrap());
    let after=service.current().unwrap();
    assert_eq!(after["files"][0]["text"],"external source");
    assert_ne!(after["sourceVersion"],before["sourceVersion"]);
    assert_ne!(after["diskGeneration"],before["diskGeneration"]);
}

#[test]
fn continuation_gist_validates_ingress_without_granting_capabilities() {
    let (dir, mut service) = service();
    let imported = json!({"settings":settings(),"files":[{"path":"main.muz","text":"draft"}],"assets":[]});
    let absent: Imported = decode(imported.clone()).unwrap();
    assert!(absent.gist.is_none());
    for gist in [
        Value::Null, json!(""), json!("A".repeat(32)), json!("a".repeat(31)),
        json!("a".repeat(41)), json!(format!("{}/{}", "a".repeat(32), "b".repeat(39))),
        json!(format!("{}/{}/{}", "a".repeat(32), "b".repeat(40), "c".repeat(40))),
        json!("https://gist.github.com/abcd"), json!("../../etc/passwd"),
    ] {
        let mut invalid = imported.clone(); invalid["gist"] = gist;
        assert!(decode::<Imported>(invalid).is_err());
    }
    let before = service.read_bindings();
    let gist = format!("{}/{}", "a".repeat(32), "b".repeat(40));
    let mut valid = imported.clone(); valid["gist"] = json!(gist);
    let snapshot = service.import_project(json!({"kind":"content","project":valid.clone()})).unwrap();
    service.watcher.stop();
    assert_eq!(snapshot["gist"],gist);
    assert_eq!(service.read_bindings().len(),before.len() + 1);
    assert!(!service.grants.iter().any(|grant| grant.id.starts_with("external:")));
    let archive_path = dir.path().join("gist.zip");
    io::write_archive(service.state.lock().as_ref().unwrap(), &archive_path).unwrap();
    let mut archive = zip::ZipArchive::new(std::fs::File::open(archive_path).unwrap()).unwrap();
    assert_eq!(archive.len(),2);
    let mut settings_text = String::new();
    std::io::Read::read_to_string(&mut archive.by_name(SETTINGS).unwrap(), &mut settings_text).unwrap();
    assert!(!settings_text.contains("gist"));
    assert!(io::import_zip(&dir.path().join("gist.zip")).unwrap().gist.is_none());
    valid["externalGrants"] = json!([{"path":"/"}]);
    assert!(decode::<Imported>(valid).is_err());
    let (_dir, mut clean) = self::service();
    start(&mut clean);
    assert!(clean.current().unwrap().get("gist").is_none());
}

#[test]
fn continuation_gist_survives_recovery_first_save_recent_and_newer_disk_relaunch() {
    let (dir, mut service) = service();
    let gist = format!("{}/{}", "1".repeat(40), "f".repeat(40));
    let snapshot = service.import_project(json!({"kind":"content","project":{"settings":settings(),"files":[{"path":"main.muz","text":"import draft"}],"assets":[],"gist":gist}})).unwrap();
    service.watcher.stop();
    let id = snapshot["project"].as_str().unwrap().to_owned();
    assert_eq!(service.storage.recovery_records().unwrap()[0]["gist"],gist);
    *service.state.lock() = None;
    assert_eq!(restore_recovery(&mut service,json!({"id":id,"action":"restore"})).unwrap()["gist"],gist);
    let root = dir.path().join("Gist Ω with spaces"); std::fs::create_dir(&root).unwrap();
    operations::adopt_save_destination(service.state.lock().as_mut().unwrap(),Arc::new(Root::open(&root).unwrap())).unwrap();
    let working = capture(&service);
    let saved = service.save(SaveInput { project:working.project.clone(),epoch:working.epoch.clone(),files:working.buffers.clone(),settings:working.settings.clone(),settings_disk_version:working.settings_disk_version.clone() },Some(working.source_version)).unwrap();
    assert!(saved["failures"].as_array().unwrap().is_empty(),"{saved}");
    assert_eq!(service.list_recent().unwrap()[0]["gist"],gist);
    assert!(serde_json::from_slice::<Value>(&std::fs::read(root.join(SETTINGS)).unwrap()).unwrap().get("gist").is_none());
    service.acknowledge(&change(capture(&service),"recovered unsaved edit")).unwrap();
    service.persist_current().unwrap(); service.shutdown().unwrap(); drop(service);
    std::fs::write(root.join("main.muz"),"newer external disk").unwrap();
    let mut relaunched = ProjectService::new(dir.path().join("data"),dir.path().join("config"),dir.path().join("resources"),Arc::new(|_|{})).unwrap();
    relaunched.watcher.stop();
    assert_eq!(relaunched.list_recent().unwrap()[0]["gist"],gist);
    let opened = relaunched.open_folder(root,None).unwrap();
    assert_eq!(opened["gist"],gist); assert_eq!(opened["project"],id);
    *relaunched.state.lock() = None;
    let restored = restore_recovery(&mut relaunched,json!({"id":id,"action":"restore"})).unwrap();
    assert_eq!(restored["gist"],gist);
    assert_eq!(restored["conflicts"][0]["local"],"recovered unsaved edit");
    assert_eq!(restored["conflicts"][0]["disk"],"newer external disk");
    let mut malformed = relaunched.storage.recovery_records().unwrap()[0].clone();
    malformed["gist"] = json!("not-a-gist");
    assert_eq!(relaunched.storage.put_recovery(&malformed).unwrap_err().code,"storage_invalid");
    let mut recent = relaunched.recents.clone(); recent[0]["gist"] = Value::Null;
    assert_eq!(relaunched.storage.save_recents(&recent).unwrap_err().code,"storage_invalid");
}

#[test]
fn continuation_partial_save_reports_racing_nested_create_and_journal_preserves_versions() {
    let (dir, mut service) = service();
    let root_path = dir.path().join("Project Ω with spaces"); std::fs::create_dir(&root_path).unwrap();
    std::fs::write(root_path.join("main.muz"),"base").unwrap();
    std::fs::write(root_path.join(SETTINGS),settings().bytes().unwrap()).unwrap();
    service.open_folder(root_path.clone(),None).unwrap(); service.watcher.stop();
    let mut working = change(capture(&service),"saved local main");
    working.buffers.push(Capture { file_id:"new-nested".into(),path:"nested Ω/new file.muz".into(),text:Some("new local nested".into()),buffer_version:1,expected_disk_version:None });
    let racing = root_path.join("nested Ω/new file.muz");
    secure_fs::set_before_publish(move || {
        // First file has passed preflight; create the second target before it publishes.
        std::fs::create_dir(racing.parent().unwrap()).unwrap();
        std::fs::write(racing,"racing external nested").unwrap();
    });
    let input = SaveInput { project:working.project.clone(),epoch:working.epoch.clone(),files:working.buffers.clone(),settings:working.settings.clone(),settings_disk_version:working.settings_disk_version.clone() };
    let saved = service.save(input,Some(working.source_version)).unwrap();
    assert_eq!(saved["saved"].as_array().unwrap().len(),1);
    assert_eq!(saved["failures"][0]["fileId"],"new-nested");
    assert_eq!(saved["failures"][0]["failure"]["code"],"source_conflict");
    assert_eq!(saved["settingsSaved"],false);
    assert_eq!(std::fs::read_to_string(root_path.join("main.muz")).unwrap(),"saved local main");
    assert_eq!(std::fs::read_to_string(root_path.join("nested Ω/new file.muz")).unwrap(),"racing external nested");
    let current = service.current().unwrap();
    let conflict = &current["conflicts"][0];
    service.resolve_conflict(&json!({"project":current["project"],"epoch":current["epoch"],"fileId":"new-nested","diskVersion":conflict["diskVersion"],"choice":"merge","mergedText":"merged nested"})).unwrap();
    let working = capture(&service);
    let racing_main = root_path.join("main.muz");
    secure_fs::set_before_publish(move || { std::fs::write(racing_main,"exchange racing main").unwrap(); });
    let expected = digest(b"saved local main");
    let root = service.state.lock().as_ref().unwrap().root.clone();
    let error = root.write("main.muz",Some(b"exchange local main"),Some(&expected),service.storage.journal_dir()).unwrap_err();
    assert_eq!(error.code,"source_conflict");
    assert_eq!(std::fs::read_to_string(root_path.join("main.muz")).unwrap(),"exchange local main");
    let records = root.recover(service.storage.journal_dir()).unwrap();
    assert!(!records.is_empty());
    let exchange = records.iter().find(|record|record["path"] == "main.muz").unwrap();
    assert_eq!(std::fs::read_to_string(exchange["backup"].as_str().unwrap()).unwrap(),"exchange racing main");
    let drafts = service.storage.recovery_records().unwrap();
    assert!(drafts[0]["capture"]["buffers"].as_array().unwrap().iter().any(|file|file["path"] == "nested Ω/new file.muz" && file["text"] == "merged nested"));
    assert!(error.help.unwrap().iter().any(|hint|hint.contains("backup")));
    assert!(working.buffers.iter().any(|file|file.text.as_deref() == Some("merged nested")));
}

#[test]
fn continuation_watch_refresh_deletion_missing_root_recents_and_preferences_are_durable() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["data","config","resources","first/same Ω","second/same Ω"] { std::fs::create_dir_all(dir.path().join(name)).unwrap(); }
    let (tx, rx) = std::sync::mpsc::channel();
    let mut service = ProjectService::new(dir.path().join("data"),dir.path().join("config"),dir.path().join("resources"),Arc::new(move |event|{let _ = tx.send(event);})).unwrap();
    let root = dir.path().join("first/same Ω"); let other = dir.path().join("second/same Ω");
    for path in [&root,&other] { std::fs::write(path.join("main.muz"),"base").unwrap(); std::fs::write(path.join(SETTINGS),settings().bytes().unwrap()).unwrap(); }
    let first = service.open_folder(root.clone(),None).unwrap();
    let second = service.open_folder(other,None).unwrap();
    assert_ne!(first["project"],second["project"]);
    assert_eq!(service.open_folder(root.clone(),None).unwrap()["project"],first["project"]);
    let wait_for = |kind: &str, state: Option<&str>| {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(8);
        loop {
            let event = rx.recv_timeout(until.saturating_duration_since(std::time::Instant::now())).unwrap();
            if event["kind"] == kind && state.is_none_or(|state|event["state"] == state) { break event; }
        }
    };
    std::fs::write(root.join("main.muz"),"clean external").unwrap();
    let refreshed = wait_for("changed",None);
    assert_eq!(refreshed["snapshot"]["files"][0]["text"],"clean external");
    assert_eq!(refreshed["snapshot"]["files"][0]["dirty"],false);
    service.acknowledge(&change(capture(&service),"dirty retained")).unwrap();
    std::fs::remove_file(root.join("main.muz")).unwrap();
    let deleted = wait_for("changed",None);
    assert_eq!(deleted["snapshot"]["conflicts"][0]["local"],"dirty retained");
    assert!(deleted["snapshot"]["conflicts"][0]["disk"].is_null());
    service.watcher.watch(&dir.path().join("nonexistent watch path"));
    assert_eq!(wait_for("watch",Some("degraded"))["failure"]["code"],"watch_unavailable");
    std::fs::rename(&root,dir.path().join("moved Ω")).unwrap();
    assert_eq!(wait_for("watch",Some("rootMissing"))["state"],"rootMissing");
    assert_eq!(service.list_recent().unwrap().as_array().unwrap().iter().find(|row|row["project"] == first["project"]).unwrap()["available"],false);
    let preferences = json!({"version":1,"theme":"soft-dark","layout":{"explorer":false,"source":true,"visualization":false,"inspector":true,"sourceFraction":0.63}});
    service.storage.save_preferences(&preferences).unwrap();
    service.shutdown().unwrap(); drop(service);
    let reloaded = ProjectService::new(dir.path().join("data"),dir.path().join("config"),dir.path().join("resources"),Arc::new(|_|{})).unwrap();
    assert_eq!(reloaded.storage.load_preferences().unwrap(),preferences);
    assert_eq!(reloaded.recovery_offers().len(),1);
}

#[test]
fn continuation_security_capture_and_failed_save_veto_all_close_reasons() {
    let (dir, mut service) = service();
    let root = dir.path().join("safe Ω"); std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("main.muz"),"disk").unwrap();
    std::fs::write(root.join(SETTINGS),settings().bytes().unwrap()).unwrap();
    service.open_folder(root.clone(),None).unwrap(); service.watcher.stop();
    let working = change(capture(&service),"dirty");
    service.acknowledge(&working).unwrap();
    let immutable = service.capture_sources(working).unwrap();
    let id = immutable["id"].as_str().unwrap();
    std::fs::write(root.join("main.muz"),"external during compile").unwrap();
    assert_eq!(service.validate_snapshot(id,&json!([])).unwrap_err().code,"source_conflict");
    assert_eq!(service.snapshot_transfer(id).unwrap().1.iter().find(|(file,_)|file["path"] == "main.muz").unwrap().1,"dirty");
    let outside = dir.path().join("outside.muz"); std::fs::write(&outside,"secret").unwrap();
    let reference = service.current_ref().unwrap();
    let readable = service.library_document(&json!({"project":reference,"id":outside})).unwrap();
    assert_eq!(readable["text"],"secret");
    for path in ["../outside.muz","/etc/passwd","new/../../outside.muz","x\\y.muz"] {
        let mut invalid = capture(&service); invalid.source_version += 1;
        invalid.buffers.push(Capture { file_id:"escape".into(),path:path.into(),text:Some("bad".into()),buffer_version:1,expected_disk_version:None });
        assert_eq!(service.acknowledge(&invalid).unwrap_err().code,"denied_path");
    }
    std::os::unix::fs::symlink(&outside,root.join("escape.muz")).unwrap();
    assert_eq!(service.state.lock().as_ref().unwrap().root.read("escape.muz",1024).err().unwrap().code,"denied_path");
    std::fs::remove_file(root.join("escape.muz")).unwrap();
    service.set_close_ticket("native-ticket".into());
    for reason in ["replaceProject","closeProject","closeWindow","quit"] {
        let input = json!({"capture":capture(&service),"reason":reason,"decision":"cancel","cancelExports":false,"ticket":"native-ticket"});
        assert_eq!(service.prepare_close(&input,0).unwrap()["allowed"],false);
        let mut save = input; save["decision"] = json!("save");
        let denied = service.prepare_close(&save,0).unwrap();
        assert_eq!(denied["allowed"],false);
        assert!(service.current_ref().is_some()); assert!(!service.close_allowed());
        assert_eq!(std::fs::read_to_string(root.join("main.muz")).unwrap(),"external during compile");
    }
    let current = service.current().unwrap();
    let conflict = &current["conflicts"][0];
    let disk = service.resolve_conflict(&json!({"project":current["project"],"epoch":current["epoch"],"fileId":conflict["fileId"],"diskVersion":conflict["diskVersion"],"choice":"disk"})).unwrap();
    assert_eq!(disk["files"][0]["text"],"external during compile");
    let mut working = change(capture(&service),"saved safe local");
    working.buffers.push(Capture { file_id:"nested-safe".into(),path:"nested Ω/new source.muz".into(),text:Some("safe nested source".into()),buffer_version:1,expected_disk_version:None });
    let approved = service.prepare_close(&json!({"capture":working,"reason":"closeWindow","decision":"save","cancelExports":false,"ticket":"native-ticket"}),0).unwrap();
    assert_eq!(approved["allowed"],true);
    assert_eq!(std::fs::read_to_string(root.join("nested Ω/new source.muz")).unwrap(),"safe nested source");
    let reference = service.current_ref().unwrap();
    let input = json!({"project":reference.project,"epoch":reference.epoch,"token":approved["token"]});
    service.close(&input).unwrap();
    assert!(service.close_allowed()); assert!(service.current_ref().is_none()); assert!(service.close(&input).is_err());
}

#[test]
fn continuation_interrupted_multifile_save_relaunch_preserves_staging_and_draft() {
    let (dir, mut service) = service();
    let root_path = dir.path().join("Interrupted Ω project"); std::fs::create_dir(&root_path).unwrap();
    std::fs::write(root_path.join("main.muz"),"entry base").unwrap();
    std::fs::write(root_path.join("other.muz"),"other base").unwrap();
    std::fs::write(root_path.join(SETTINGS),settings().bytes().unwrap()).unwrap();
    let opened = service.open_folder(root_path.clone(),None).unwrap(); service.watcher.stop();
    let mut working = capture(&service); working.source_version += 1;
    working.buffers.sort_by(|left, right| left.path.cmp(&right.path));
    for file in &mut working.buffers { file.buffer_version += 1; file.text = Some(format!("local {}",file.path)); }
    secure_fs::set_before_publish(|| {
        secure_fs::set_before_publish(|| panic!("injected termination before second publication"));
    });
    let input = SaveInput { project:working.project.clone(),epoch:working.epoch.clone(),files:working.buffers.clone(),settings:working.settings.clone(),settings_disk_version:working.settings_disk_version.clone() };
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||service.save(input,Some(working.source_version)))).is_err());
    assert_eq!(std::fs::read_to_string(root_path.join("main.muz")).unwrap(),"local main.muz");
    assert_eq!(std::fs::read_to_string(root_path.join("other.muz")).unwrap(),"other base");
    drop(service);
    let root = Root::open(&root_path).unwrap();
    let journal = dir.path().join("data/muzpad-save-journal-v1");
    let interrupted = root.recover(&journal).unwrap();
    assert_eq!(interrupted.len(),1);
    assert_eq!(interrupted[0]["state"],"interrupted-or-external-change");
    assert_eq!(std::fs::read_to_string(interrupted[0]["backup"].as_str().unwrap()).unwrap(),"local other.muz");
    let mut relaunched = ProjectService::new(dir.path().join("data"),dir.path().join("config"),dir.path().join("resources"),Arc::new(|_|{})).unwrap();
    relaunched.watcher.stop();
    let restored = restore_recovery(&mut relaunched,json!({"id":opened["project"],"action":"restore"})).unwrap();
    assert!(restored["files"].as_array().unwrap().iter().all(|file|file["text"].as_str().unwrap().starts_with("local ")));
    assert_eq!(std::fs::read_to_string(root_path.join("other.muz")).unwrap(),"other base");
}

#[test]
fn continuation_preferences_malformed_and_denied_writes_preserve_latest_value_and_sources() {
    let (dir, mut service) = service(); start(&mut service);
    let before = service.current().unwrap();
    let context = Context::host(None,None);
    let mut value = json!({"version":1,"theme":"dark","layout":{"explorer":true,"source":true,"visualization":true,"inspector":true,"sourceFraction":0.41}});
    for theme in ["light","soft-light","dark","soft-dark"] {
        value["theme"] = json!(theme);
        service.dispatch("preferences.save",json!({"value":value}),&context).unwrap();
    }
    assert_eq!(service.dispatch("preferences.load",json!({}),&context).unwrap(),value);
    let mut malformed = value.clone(); malformed["layout"]["sourceFraction"] = json!(0);
    assert!(service.dispatch("preferences.save",json!({"value":malformed}),&context).is_err());
    assert_eq!(service.storage.load_preferences().unwrap(),value);
    let preferences_path = dir.path().join("config/muzpad-preferences-v1.json");
    let durable_path = dir.path().join("config/retained-preferences.json");
    std::fs::rename(&preferences_path,&durable_path).unwrap();
    std::os::unix::fs::symlink(&durable_path,&preferences_path).unwrap();
    assert!(service.dispatch("preferences.save",json!({"value":value}),&context).is_err());
    assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&durable_path).unwrap()).unwrap(),value);
    assert_eq!(service.current().unwrap(),before);
    std::fs::remove_file(preferences_path).unwrap();
    std::fs::rename(durable_path,dir.path().join("config/muzpad-preferences-v1.json")).unwrap();
}

#[test]
fn continuation_snapshot_default_entries_roundtrip_does_not_invent_source_version() {
    let (dir, mut service) = service(); start(&mut service);
    let mut first = capture(&service); first.settings.entries = Some(vec![first.entry.clone()]);
    assert_eq!(first.source_version,1);
    let snapshot = service.capture_sources(first.clone()).unwrap();
    assert_eq!(snapshot["sourceVersion"],first.source_version);
    assert_eq!(service.capture_sources(first.clone()).unwrap()["sourceVersion"],first.source_version);
    assert_eq!(service.current().unwrap()["sourceVersion"],first.source_version);
    *service.state.lock() = None;
    let root = dir.path().join("Default entries Ω"); std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("main.muz"),"disk source").unwrap();
    std::fs::write(root.join(SETTINGS),settings().bytes().unwrap()).unwrap();
    service.open_folder(root,None).unwrap();
    let mut disk = capture(&service); disk.settings.entries = Some(vec![disk.entry.clone()]);
    assert_eq!(service.capture_sources(disk.clone()).unwrap()["sourceVersion"],disk.source_version);
    assert_eq!(service.current().unwrap()["dirty"],false);
    let mut changed = disk; changed.settings.entries = Some(Vec::new());
    changed.source_version += 1;
    service.acknowledge(&changed).unwrap();
    assert_eq!(service.current().unwrap()["dirty"],true);
    assert!(service.current().unwrap()["entries"].as_array().unwrap().is_empty());
}

#[test]
fn continuation_ui_library_ids_preserve_echo_and_trusted_account_reads() {
    let (dir, mut service) = service(); start(&mut service);
    let reference = service.current_ref().unwrap();
    let (name, text) = muz::lang::STANDARD_MODULES.first().unwrap();
    let id = format!("library:{name}.muz");
    let standard = service.library_document(&json!({"project":reference,"id":id})).unwrap();
    assert_eq!(standard["id"],id); assert_eq!(standard["text"],*text);
    std::fs::write(dir.path().join("resources/library/contrib/test/module.muz"),"packaged module").unwrap();
    let id = "library:contrib/test/module.muz";
    let packaged = service.library_document(&json!({"project":reference,"id":id})).unwrap();
    assert_eq!(packaged["id"],id); assert_eq!(packaged["text"],"packaged module");
    let outside = dir.path().join("outside"); std::fs::create_dir(&outside).unwrap();
    let document = outside.join("module Ω.muz"); std::fs::write(&document,"authorized module").unwrap();
    let id = format!("library:{}",document.display());
    let authorized = service.library_document(&json!({"project":reference,"id":id})).unwrap();
    assert_eq!(authorized["id"],id); assert_eq!(authorized["text"],"authorized module");
    for id in ["library:../outside/module Ω.muz","library:contrib/../../outside/module Ω.muz"] {
        assert_eq!(service.library_document(&json!({"project":reference,"id":id})).unwrap_err().code,"denied_path");
    }
}

fn save_working(service: &mut ProjectService) -> Value {
    let working = capture(service);
    service.save(SaveInput { project:working.project,epoch:working.epoch,files:working.buffers,settings:working.settings,settings_disk_version:working.settings_disk_version },Some(working.source_version)).unwrap()
}

#[test]
fn closure_retained_save_authority_preserves_captured_text_and_disk_resources() {
    for first_save in [false,true] {
        let (dir,mut service) = service();
        let destination = dir.path().join("Saved project Ω"); std::fs::create_dir(&destination).unwrap();
        if first_save { start(&mut service); } else {
            std::fs::write(destination.join("main.muz"),"disk A").unwrap();
            std::fs::write(destination.join(SETTINGS),settings().bytes().unwrap()).unwrap();
            service.open_folder(destination.clone(),None).unwrap(); service.watcher.stop();
        }
        let root = service.state.lock().as_ref().unwrap().root.path().to_owned();
        std::fs::write(root.join("sample.wav"),b"pinned asset").unwrap();
        std::fs::write(dir.path().join("resources/library/module.muz"),"pinned library").unwrap();
        { let mut state = service.state.lock(); rescan(state.as_mut().unwrap()).unwrap(); }
        let snapshot = service.capture_sources(change(capture(&service),"accepted B")).unwrap();
        let id = snapshot["id"].as_str().unwrap(); let grant = project_grant(&service.current_ref().unwrap().project);
        let dependencies = json!([{"grant":grant,"path":root.join("main.muz"),"version":digest(b"accepted B")},{"grant":grant,"path":root.join("sample.wav"),"version":digest(b"pinned asset")}]);
        service.validate_snapshot(id,&dependencies).unwrap(); service.retain_accepted_snapshot(id).unwrap();
        if first_save {
            { let mut state = service.state.lock(); let workspace = state.as_mut().unwrap();
                for resource in &mut workspace.resources {
                    resource["version"] = json!(workspace.root.fingerprint(resource["path"].as_str().unwrap(),MAX_ASSETS).unwrap());
                    resource["pendingSave"] = json!(true);
                }
                operations::adopt_save_destination(workspace,Arc::new(Root::open(&destination).unwrap())).unwrap();
            }
        }
        let saved = save_working(&mut service); assert_eq!(saved["settingsSaved"],true,"{saved}");
        assert_eq!(std::fs::read_to_string(destination.join("main.muz")).unwrap(),"accepted B");
        let resolved = service.resolve_source_document(&json!({"project":service.current_ref(),"path":root.join("main.muz")})).unwrap();
        assert_eq!(resolved["kind"],"project"); assert_eq!(resolved["path"],"main.muz");
        assert_eq!(service.validate_snapshot(id,&dependencies).unwrap_err().code,"source_conflict");
        let restarted = json!([{"grant":grant,"path":destination.join("main.muz"),"version":digest(b"accepted B")},{"grant":grant,"path":destination.join("sample.wav"),"version":digest(b"pinned asset")}]);
        service.validate_retained_snapshot(id,&restarted).unwrap();
        assert_eq!(service.snapshot_transfer(id).unwrap().1.iter().find(|(file,_)|file["path"] == "main.muz").unwrap().1,"accepted B");
        std::fs::write(destination.join("sample.wav"),b"actual pinned change").unwrap();
        assert_eq!(service.validate_retained_snapshot(id,&restarted).unwrap_err().code,"changed_asset");
        std::fs::write(destination.join("sample.wav"),b"pinned asset").unwrap();
        std::fs::write(dir.path().join("resources/library/module.muz"),"changed library").unwrap();
        service.validate_retained_snapshot(id,&restarted).unwrap();
    }
}

#[test]
fn closure_import_reclaims_partial_orphans_and_preserves_recovery_assets() {
    use base64::Engine;
    let (dir,mut service) = service();
    let asset = base64::engine::general_purpose::STANDARD.encode(b"recoverable bytes");
    let imported = json!({"kind":"content","project":{"settings":settings(),"files":[{"path":"main.muz","text":"draft"}],"assets":[{"path":"one.wav","format":"wav","base64":asset}]}});
    service.import_project(imported.clone()).unwrap(); service.watcher.stop();
    let active = service.state.lock().as_ref().unwrap().root.path().to_owned();
    let mut broken = imported.clone(); broken["project"]["assets"].as_array_mut().unwrap().push(json!({"path":"two.wav","format":"wav","base64":"not base64"}));
    let approved = service.prepare_close(&json!({"capture":capture(&service),"reason":"replaceProject","decision":"discard","ticket":null}),0).unwrap();
    let reference = service.current_ref().unwrap();
    service.close(&json!({"project":reference.project,"epoch":reference.epoch,"token":approved["token"]})).unwrap();
    assert_eq!(service.import_project(broken).unwrap_err().code,"invalid_source");
    assert_eq!(std::fs::read_dir(&service.workspace_dir).unwrap().count(),1);
    assert_eq!(std::fs::read(active.join("one.wav")).unwrap(),b"recoverable bytes");
    service.import_project(imported).unwrap();
    let saved_private = service.state.lock().as_ref().unwrap().root.path().to_owned();
    let destination = dir.path().join("Saved import"); std::fs::create_dir(&destination).unwrap();
    operations::adopt_save_destination(service.state.lock().as_mut().unwrap(),Arc::new(Root::open(&destination).unwrap())).unwrap();
    let saved = save_working(&mut service); assert_eq!(saved["settingsSaved"],true,"{saved}");
    assert!(!saved_private.exists()); assert!(active.exists());
    assert_eq!(std::fs::read(destination.join("one.wav")).unwrap(),b"recoverable bytes");
    restore_recovery(&mut service,json!({"id":reference.project,"action":"discard"})).unwrap();
    assert!(active.exists(),"Cancel-preview still owns the previous workspace after its recovery offer is discarded");
    let saved_project=service.current_ref().unwrap().project;
    permit_replacement(&mut service);service.open_folder(destination.clone(),Some(saved_project)).unwrap();
    assert!(!active.exists(),"A genuine trusted-folder cutover releases the previous preview root");
    for index in 0..180 { std::fs::create_dir(service.workspace_dir.join(format!("orphan-{index}"))).unwrap(); }
    service.reclaim_private_workspaces_checked().unwrap(); service.reclaim_private_workspaces_checked().unwrap();
    assert_eq!(std::fs::read_dir(&service.workspace_dir).unwrap().count(),0);
}

#[test]
fn closure_source_identity_resolver_preserves_project_buffers_and_canonical_account_reads() {
    let (dir,mut service) = service(); start(&mut service);
    let project_root = service.state.lock().as_ref().unwrap().root.path().to_owned();
    let reference = service.current_ref().unwrap();
    let file_id = capture(&service).buffers[0].file_id.clone();
    let resolve = |service:&ProjectService,path:PathBuf| service.resolve_source_document(&json!({"project":reference,"path":path}));
    assert_eq!(resolve(&service,project_root.join("main.muz")).unwrap(),json!({"kind":"project","path":"main.muz","fileId":file_id}));
    assert!(resolve(&service,project_root.join("unknown/main.muz")).unwrap().is_null());
    assert_eq!(resolve(&service,project_root.join("../main.muz")).unwrap_err().code,"denied_path");
    let outside = dir.path().join("Outside Ω"); std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("main.muz"),"external same basename").unwrap();
    std::fs::write(outside.join("other.muz"),"ungranted sibling").unwrap();
    let readonly = resolve(&service,outside.join("main.muz")).unwrap();
    assert_eq!(readonly["kind"],"library"); assert_eq!(readonly["text"],"external same basename");
    assert_eq!(service.library_document(&json!({"project":reference,"id":readonly["id"]})).unwrap()["text"],readonly["text"]);
    assert_eq!(resolve(&service,outside.join("other.muz")).unwrap()["text"],"ungranted sibling");
    std::fs::remove_file(outside.join("main.muz")).unwrap();
    std::os::unix::fs::symlink(outside.join("other.muz"),outside.join("main.muz")).unwrap();
    assert_eq!(resolve(&service,outside.join("main.muz")).unwrap()["path"],outside.join("other.muz").to_string_lossy().as_ref());
    std::fs::rename(&outside,dir.path().join("old outside")).unwrap(); std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("main.muz"),"replacement root").unwrap();
    assert_eq!(resolve(&service,outside.join("main.muz")).unwrap()["text"],"replacement root");
}

#[test]
fn closure_rescan_required_reconciles_clean_and_conflicted_local_sources() {
    let dir = tempfile::tempdir().unwrap();
    for path in ["data","config","resources","project"] { std::fs::create_dir(dir.path().join(path)).unwrap(); }
    let root = dir.path().join("project");
    std::fs::write(root.join("main.muz"),"base").unwrap();
    std::fs::write(root.join("clean.muz"),"clean base").unwrap();
    std::fs::write(root.join(SETTINGS),settings().bytes().unwrap()).unwrap();
    let (tx,rx) = std::sync::mpsc::channel();
    let mut service = ProjectService::new(dir.path().join("data"),dir.path().join("config"),dir.path().join("resources"),Arc::new(move |event| {tx.send(event).unwrap();})).unwrap();
    service.open_folder(root.clone(),None).unwrap();
    let mut working = capture(&service); working.source_version += 1;
    let main = working.buffers.iter_mut().find(|file|file.path == "main.muz").unwrap(); main.text = Some("local retained".into()); main.buffer_version += 1;
    service.acknowledge(&working).unwrap();
    let scan_barrier = service.state.lock();
    std::fs::write(root.join("main.muz"),"external after overflow").unwrap(); std::fs::write(root.join("clean.muz"),"clean after overflow").unwrap();
    service.watcher.inject_rescan_required();
    drop(scan_barrier);
    let until = std::time::Instant::now()+std::time::Duration::from_secs(8); let mut degraded = false; let mut reconciled = false;
    while !degraded || !reconciled {
        let event = rx.recv_timeout(until.saturating_duration_since(std::time::Instant::now())).unwrap();
        degraded |= event["kind"] == "watch" && event["state"] == "degraded";
        if event["kind"] == "changed" {
            let files = event["snapshot"]["files"].as_array().unwrap();
            reconciled |= files.iter().any(|file|file["path"] == "clean.muz" && file["text"] == "clean after overflow")
                && event["snapshot"]["conflicts"].as_array().unwrap().iter().any(|conflict|conflict["local"] == "local retained" && conflict["disk"] == "external after overflow");
            if reconciled { assert!(degraded,"Rescan-required degradation must precede reconciliation"); }
        }
    }
    service.persist_current().unwrap();
    assert!(service.storage.recovery_records().unwrap()[0]["capture"]["buffers"].as_array().unwrap().iter().any(|file|file["text"] == "local retained"));
    service.watcher.stop();
}

#[test]
fn closure_read_save_and_recovery_storage_errors_retain_editing_and_veto_close() {
    let (dir,mut service) = service(); let root = dir.path().join("Failure project"); std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("main.muz"),"base").unwrap(); std::fs::write(root.join(SETTINGS),settings().bytes().unwrap()).unwrap();
    service.open_folder(root.clone(),None).unwrap(); service.watcher.stop();
    service.acknowledge(&change(capture(&service),"retained draft")).unwrap(); service.persist_current().unwrap();
    let outside = dir.path().join("outside.muz"); std::fs::write(&outside,"not project").unwrap();
    std::fs::remove_file(root.join("main.muz")).unwrap(); std::os::unix::fs::symlink(&outside,root.join("main.muz")).unwrap();
    let context = Context::host(None,service.current_ref());
    assert_eq!(service.state.lock().as_ref().unwrap().root.read("main.muz",1024).err().unwrap().code,"denied_path");
    let refreshed = service.dispatch("project.refresh",json!({"input":capture(&service)}),&context).unwrap();
    assert_eq!(refreshed["conflicts"][0]["local"],"retained draft"); assert!(refreshed["conflicts"][0]["disk"].is_null());
    service.set_close_ticket("failure-ticket".into());
    for reason in ["replaceProject","closeProject","closeWindow","quit"] {
        let result = service.prepare_close(&json!({"capture":capture(&service),"decision":"save","reason":reason,"ticket":"failure-ticket"}),0).unwrap();
        assert_eq!(result["allowed"],false); assert_eq!(result["failure"]["code"],"source_conflict");
    }
    std::fs::remove_file(root.join("main.muz")).unwrap(); std::fs::write(root.join("main.muz"),"base").unwrap();
    { let mut state = service.state.lock(); rescan(state.as_mut().unwrap()).unwrap(); }
    // Deny publication in the real descriptor-pinned recovery directory.
    use std::os::unix::fs::PermissionsExt;
    let recovery = dir.path().join("data/muzpad-recovery-v1");
    std::fs::set_permissions(&recovery,std::fs::Permissions::from_mode(0o500)).unwrap();
    assert_eq!(service.persist_current().unwrap_err().code,"permission_denied");
    for reason in ["replaceProject","closeProject","closeWindow","quit"] {
        let input = json!({"capture":capture(&service),"decision":"discard","reason":reason,"ticket":"failure-ticket"});
        assert!(service.prepare_close(&input,0).is_err());
    }
    service.acknowledge(&change(capture(&service),"newer typing after errors")).unwrap();
    assert_eq!(service.current().unwrap()["files"][0]["text"],"newer typing after errors");
    assert!(!service.close_allowed()); assert!(service.current_ref().is_some());
    assert!(std::fs::read_dir(&recovery).unwrap().next().is_some());
    std::fs::set_permissions(&recovery,std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn closure_permission_failures_retain_local_source_and_veto_safe_close() {
    use std::os::unix::fs::PermissionsExt;
    assert_ne!(unsafe { libc::geteuid() },0,"Permission acceptance requires an unprivileged host user");
    let (dir,mut service) = service(); let root = dir.path().join("Permissions Ω"); std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("main.muz"),"base").unwrap(); std::fs::write(root.join(SETTINGS),settings().bytes().unwrap()).unwrap();
    service.open_folder(root.clone(),None).unwrap(); service.watcher.stop();
    service.acknowledge(&change(capture(&service),"permission retained local")).unwrap(); service.persist_current().unwrap();
    std::fs::set_permissions(root.join("main.muz"),std::fs::Permissions::from_mode(0o000)).unwrap();
    let context = Context::host(None,service.current_ref());
    assert_eq!(service.dispatch("project.refresh",json!({"input":capture(&service)}),&context).unwrap_err().code,"permission_denied");
    std::fs::set_permissions(root.join("main.muz"),std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::set_permissions(&root,std::fs::Permissions::from_mode(0o500)).unwrap();
    let saved = save_working(&mut service);
    assert_eq!(saved["settingsSaved"],false); assert_eq!(saved["failures"][0]["failure"]["code"],"permission_denied");
    service.set_close_ticket("permission-ticket".into());
    for reason in ["replaceProject","closeProject","closeWindow","quit"] {
        let result = service.prepare_close(&json!({"capture":capture(&service),"decision":"save","reason":reason,"ticket":"permission-ticket"}),0).unwrap();
        assert_eq!(result["allowed"],false); assert_eq!(result["save"]["failures"][0]["failure"]["code"],"permission_denied");
    }
    service.acknowledge(&change(capture(&service),"continued typing after permission errors")).unwrap();
    assert_eq!(service.current().unwrap()["files"][0]["text"],"continued typing after permission errors");
    assert_eq!(std::fs::read_to_string(root.join("main.muz")).unwrap(),"base"); assert!(!service.close_allowed());
    std::fs::set_permissions(&root,std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn native_captured_rebuild(service: &ProjectService, id: &str, retained: bool, engine: &Arc<crate::supervisor::Supervisor>, events: &std::sync::mpsc::Receiver<Value>) -> Result<Value,Failure> {
    use base64::Engine;
    use std::time::Duration;
    let (snapshot,files) = service.snapshot_transfer(id).unwrap();
    let mut context = Context::host(Some(engine.epoch.clone()),service.current_ref()); context.source_version = snapshot["sourceVersion"].as_u64();
    let mut request = |command:&str,args:Value| { context.request_id = opaque(); engine.request_timeout(&context,command,args,Some(Duration::from_secs(15))).unwrap() };
    request("hello",json!({"coreRevision":env!("MUZPAD_CORE_REVISION"),"limits":crate::protocol::limits()}));
    request("configureProject",json!({"project":service.current_ref(),"readBindings":service.read_bindings(),"trustedRead":service.trusted_read()}));
    request("snapshotBegin",json!({"snapshot":snapshot,"files":files.iter().map(|(file,_)|file).collect::<Vec<_>>()}));
    for (file,text) in &files { for (index,chunk) in text.as_bytes().chunks(crate::protocol::CHUNK_BYTES).enumerate() {
        request("snapshotChunk",json!({"snapshot":id,"fileId":file["fileId"],"index":index,"data":base64::engine::general_purpose::STANDARD.encode(chunk)}));
    } }
    request("snapshotFinish",json!({"snapshot":id}));
    context.request_id = opaque(); let rebuild_context = context.clone(); let owner = engine.clone(); let snapshot_id = id.to_owned();
    let build = std::thread::spawn(move || owner.request_timeout(&rebuild_context,"rebuild",json!({"snapshot":snapshot_id,"base":null}),Some(Duration::from_secs(20))));
    let until = std::time::Instant::now()+Duration::from_secs(15);
    loop {
        let event = events.recv_timeout(until.saturating_duration_since(std::time::Instant::now())).unwrap();
        let value = &event["event"]["value"];
        if event["event"]["scope"] == "internal" && value["kind"] == "prepared" {
            let validation = if retained { service.validate_retained_snapshot(id,&value["dependencyVersions"]) } else { service.validate_snapshot(id,&value["dependencyVersions"]) };
            context.request_id = opaque();
            engine.request_timeout(&context,"authorizeApply",json!({"target":value["requestId"],"authorization":value["authorization"],"allowed":validation.is_ok(),"failure":validation.err()}),Some(Duration::from_secs(5))).unwrap();
            break;
        }
    }
    build.join().unwrap()
}

#[test]
fn closure_real_native_child_save_crash_restart_and_changed_pinned_asset() {
    use std::time::Duration;
    let executable = std::env::var_os("MUZPAD_TEST_ENGINE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/release/muzpad-engine"));
    for first_save in [false,true] {
        let (dir,mut service) = service(); let destination = dir.path().join("Native saved Ω"); std::fs::create_dir(&destination).unwrap();
        if first_save { start(&mut service); } else {
            std::fs::write(destination.join("main.muz"),"song({tracks:[track(\"lead\",phrase(\"C4:q\"),synth(\"bell\"))]});").unwrap();
            std::fs::write(destination.join(SETTINGS),settings().bytes().unwrap()).unwrap();
            service.open_folder(destination.clone(),None).unwrap(); service.watcher.stop();
        }
        let root = service.state.lock().as_ref().unwrap().root.path().to_owned();
        let mut wav = hound::WavWriter::create(root.join("tone.wav"),hound::WavSpec { channels:1,sample_rate:48000,bits_per_sample:16,sample_format:hound::SampleFormat::Int }).unwrap();
        for index in 0..4800 { wav.write_sample(((index as f32*0.07).sin()*2000.0) as i16).unwrap(); } wav.finalize().unwrap();
        { let mut state = service.state.lock(); rescan(state.as_mut().unwrap()).unwrap(); }
        let text = "song({title:\"Retained B\",tempo:120,tracks:[track(\"sample\",phrase(\"C4:q\"),sample(\"tone.wav\",{root:60,gain_db:-12}))],tail:0.1});";
        let descriptor = service.capture_sources(change(capture(&service),text)).unwrap(); let id = descriptor["id"].as_str().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let (tx,events) = std::sync::mpsc::channel();
        let engine = crate::supervisor::Supervisor::spawn(executable.clone(),cache.path(),Arc::new(move |event| { let _ = tx.send(event); })).unwrap();
        let accepted = native_captured_rebuild(&service,id,false,&engine,&events).unwrap();
        assert!(accepted["ref"].is_object()); service.retain_accepted_snapshot(id).unwrap();
        if first_save {
            let mut state = service.state.lock(); let workspace = state.as_mut().unwrap();
            for resource in &mut workspace.resources {
                resource["version"] = json!(workspace.root.fingerprint(resource["path"].as_str().unwrap(),MAX_ASSETS).unwrap());
                resource["pendingSave"] = json!(true);
            }
            operations::adopt_save_destination(workspace,Arc::new(Root::open(&destination).unwrap())).unwrap();
        }
        assert_eq!(save_working(&mut service)["settingsSaved"],true);
        engine.crash_for_test();
        let until = std::time::Instant::now()+Duration::from_secs(5);
        while engine.is_alive() { assert!(std::time::Instant::now()<until); std::thread::sleep(Duration::from_millis(10)); }
        assert_eq!(service.current().unwrap()["files"][0]["text"],text);
        let (tx,events) = std::sync::mpsc::channel();
        let restarted = crate::supervisor::Supervisor::spawn(executable.clone(),cache.path(),Arc::new(move |event| { let _ = tx.send(event); })).unwrap();
        let restored = native_captured_rebuild(&service,id,true,&restarted,&events).unwrap();
        assert!(restored["ref"].is_object()); assert_ne!(restored["ref"],accepted["ref"]); restarted.shutdown();
        let mut wav = hound::WavWriter::create(destination.join("tone.wav"),hound::WavSpec { channels:1,sample_rate:48000,bits_per_sample:16,sample_format:hound::SampleFormat::Int }).unwrap();
        for _ in 0..4800 { wav.write_sample(500_i16).unwrap(); } wav.finalize().unwrap();
        let (tx,events) = std::sync::mpsc::channel();
        let rejected = crate::supervisor::Supervisor::spawn(executable.clone(),cache.path(),Arc::new(move |event| { let _ = tx.send(event); })).unwrap();
        assert_eq!(native_captured_rebuild(&service,id,true,&rejected,&events).unwrap_err().code,"changed_asset"); rejected.shutdown();
    }
}

#[test]
fn closure_source_identity_resolves_authorized_standard_relative_aliases() {
    let (_dir,mut service) = service(); start(&mut service);
    for path in ["std/synthesis","std/synthesis.muz"] {
        let document = service.resolve_source_document(&json!({"project":service.current_ref(),"path":path})).unwrap();
        assert_eq!(document["kind"],"library"); assert_eq!(document["path"],"std/synthesis.muz"); assert_eq!(document["documentKind"],"source");
        assert_eq!(service.library_document(&json!({"project":service.current_ref(),"id":document["id"]})).unwrap()["text"],document["text"]);
    }
}

#[test]
fn closure_failed_recovery_close_revokes_prior_approved_token() {
    use std::os::unix::fs::PermissionsExt;
    let (dir,mut service) = service(); start(&mut service);
    let input = json!({"capture":capture(&service),"reason":"closeProject","decision":"discard","ticket":null});
    let approved = service.prepare_close(&input,0).unwrap(); assert_eq!(approved["allowed"],true);
    let recovery = dir.path().join("data/muzpad-recovery-v1");
    std::fs::set_permissions(&recovery,std::fs::Permissions::from_mode(0o500)).unwrap();
    assert!(service.prepare_close(&input,0).is_err());
    let reference = service.current_ref().unwrap();
    assert_eq!(service.close(&json!({"project":reference.project,"epoch":reference.epoch,"token":approved["token"]})).unwrap_err().code,"close_required");
    assert!(service.current_ref().is_some()); assert!(!service.close_allowed());
    std::fs::set_permissions(&recovery,std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn closure_reveal_uses_file_manager_uris_and_bounds_failed_or_hanging_client() {
    use std::time::{Duration,Instant};
    let path = Path::new("/tmp/Project Ω spaces/reading 'quoted'.md");
    for folder in [false,true] {
        let command = operations::file_manager_command(path,folder).unwrap();
        assert_eq!(command.get_program(),"gdbus");
        let args:Vec<_> = command.get_args().map(|arg|arg.to_str().unwrap()).collect();
        assert!(args.contains(&if folder { "org.freedesktop.FileManager1.ShowFolders" } else { "org.freedesktop.FileManager1.ShowItems" }));
        assert!(args.contains(&"--session")); assert!(args.contains(&"org.freedesktop.FileManager1"));
        let uris:Vec<String> = serde_json::from_str(args[args.len()-2]).unwrap();
        assert_eq!(url::Url::parse(&uris[0]).unwrap().to_file_path().unwrap(),path);
    }
    assert_eq!(operations::file_manager_command(Path::new("relative.muz"),false).unwrap_err().code,"denied_path");
    assert_eq!(operations::run_file_manager(&mut std::process::Command::new("/bin/false"),Duration::from_secs(1)).unwrap_err().code,"file_manager_unavailable");
    let mut hanging = std::process::Command::new("/bin/sleep"); hanging.arg("10");
    let before = Instant::now();
    assert_eq!(operations::run_file_manager(&mut hanging,Duration::from_millis(100)).unwrap_err().code,"file_manager_unavailable");
    assert!(before.elapsed()<Duration::from_secs(1));
    let (_dir,mut service) = service(); start(&mut service);
    let reference = service.current_ref().unwrap();
    assert_eq!(service.reveal(&json!({"project":reference.project,"epoch":reference.epoch,"id":"not-authorized"})).unwrap_err().code,"denied_path");
    assert_eq!(service.reveal(&json!({"project":reference.project,"epoch":reference.epoch,"id":capture(&service).buffers[0].file_id})).unwrap_err().code,"project_missing");
}
