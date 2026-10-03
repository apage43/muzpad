use super::*;

pub(super) fn adopt_save_destination(workspace: &mut Workspace, root: Arc<Root>) -> Result<(),Failure> {
    // Linked libraries retain their authority and identity; they are not project output.
    // Never adopt destination bytes as an unsaved project's baseline.
    for file in workspace.files.values() {
        if root.fingerprint(&file.path,MAX_ASSETS)?.is_some() {
            return Err(failure("source_conflict",format!("Destination already contains {}; choose an empty destination",file.path)));
        }
    }
    if root.fingerprint(SETTINGS,MAX_ASSETS)?.is_some() {
        return Err(failure("source_conflict","Destination already contains muzpad.json"));
    }
    for resource in workspace.resources.iter().filter(|resource| resource["linked"] != true) {
        if let Some(path) = resource["path"].as_str() {
            if root.fingerprint(path,MAX_ASSETS)?.is_some() {
                return Err(failure("source_conflict",format!("Destination already contains {path}")));
            }
        }
    }
    workspace.asset_origin = Some(workspace.root.clone());
    workspace.root = root;
    workspace.persisted = true;
    Ok(())
}

impl ProjectService {
    pub(super) fn save(&mut self, input: SaveInput, source_version: Option<u64>) -> Result<Value, Failure> {
        let state = self.state.clone();
        let mut guard = state.lock();
        let workspace = guard.as_mut().ok_or_else(|| failure("stale_request", "No open project"))?;
        workspace.assert_ref(&input.project,&input.epoch)?;
        let capture = WorkingCapture { project:input.project.clone(),epoch:input.epoch.clone(),source_version:source_version.unwrap_or(workspace.source_version),entry:input.settings.entry.clone(),expected_disk_generation:workspace.disk_generation.to_string(),buffers:input.files.clone(),settings:input.settings.clone(),settings_disk_version:input.settings_disk_version.clone() };
        workspace.acknowledge(&capture)?;
        let settings_bytes = input.settings.bytes()?;
        drop(guard);
        self.persist_current()?;
        let mut guard = state.lock();
        let workspace = guard.as_mut().ok_or_else(|| failure("stale_request", "No open project"))?;
        let conflicts = workspace.conflicts();
        if !conflicts.is_empty() {
            let result = json!({"saved":[],"conflicts":conflicts,"failures":[],"settingsDiskVersion":workspace.settings_version,"settingsSaved":false,"diskGeneration":workspace.disk_generation.to_string()});
            let snapshot = workspace.snapshot(); drop(guard); self.emit_changed(snapshot,"conflict"); return Ok(result);
        }
        if !workspace.persisted {
            drop(guard);
            let Some(destination) = rfd::FileDialog::new().set_title("Choose project save destination").pick_folder() else { return Err(failure("cancelled", "Project save destination selection cancelled")); };
            let root = Arc::new(Root::open(&destination)?);
            guard = state.lock(); let workspace = guard.as_mut().ok_or_else(|| failure("stale_request", "No open project"))?;
            if workspace_fingerprint(workspace) != digest(&serde_json::to_vec(&capture).map_err(|e| failure("invalid_source", e.to_string()))?) { return Err(failure("stale_request", "Project changed while choosing a destination")); }
            adopt_save_destination(workspace,root)?;
            self.watcher.watch(workspace.root.path());
        }
        let workspace = guard.as_mut().ok_or_else(|| failure("stale_request", "No open project"))?;
        let mut conflicts = Vec::new();
        // Preflight every captured baseline before publishing any file or settings.
        for capture in &input.files {
            let actual = workspace.root.read(&capture.path,SOURCE_DOCUMENT_BYTES)?;
            if actual.as_ref().map(|v| &v.version) != capture.expected_disk_version.as_ref() {
                let disk = actual.as_ref().map(|v| std::str::from_utf8(&v.bytes)).transpose().map_err(|_| failure("invalid_source", "Changed disk source is not UTF-8"))?;
                let file = workspace.files.get_mut(&capture.file_id).ok_or_else(|| failure("stale_request", "Captured file disappeared"))?;
                let conflict = file.conflict_with(disk,actual.as_ref().map(|v| v.version.as_str())); file.conflict = Some(conflict.clone()); conflicts.push(conflict);
            }
        }
        let disk_settings = workspace.root.read(SETTINGS,SOURCE_DOCUMENT_BYTES)?;
        if disk_settings.as_ref().map(|v| &v.version) != input.settings_disk_version.as_ref() {
            let text = disk_settings.as_ref().map(|v| std::str::from_utf8(&v.bytes)).transpose().map_err(|_| failure("invalid_source", "Changed muzpad.json is not UTF-8"))?;
            let conflict = json!({"fileId":"settings","path":SETTINGS,"base":workspace.settings_base,"local":String::from_utf8(input.settings.bytes()?).map_err(|_|failure("invalid_source","Settings encoding failed"))?,"disk":text,"baseVersion":workspace.settings_version,"diskVersion":disk_settings.as_ref().map(|v| &v.version),"bufferVersion":workspace.source_version});
            workspace.settings_conflict = Some(conflict.clone()); conflicts.push(conflict);
        }
        if !conflicts.is_empty() {
            workspace.disk_generation = workspace.disk_generation.checked_add(1).ok_or_else(|| failure("resource_budget", "Disk generation exhausted"))?;
            let result = json!({"saved":[],"conflicts":conflicts,"failures":[],"settingsDiskVersion":workspace.settings_version,"settingsSaved":false,"diskGeneration":workspace.disk_generation.to_string()});
            let snapshot = workspace.snapshot(); drop(guard); self.emit_changed(snapshot,"conflict"); return Ok(result);
        }
        let mut saved = Vec::new(); let mut failures = Vec::new();
        for capture in &input.files {
            let unchanged = workspace.files.get(&capture.file_id).is_some_and(|file| file.base == capture.text);
            let result = if unchanged { Ok(capture.expected_disk_version.clone()) } else { workspace.root.write(&capture.path,capture.text.as_deref().map(str::as_bytes),capture.expected_disk_version.as_deref(),self.storage.journal_dir()) };
            match result {
                Ok(version) => {
                    if let Some(file) = workspace.files.get_mut(&capture.file_id) {
                        if !unchanged {
                            file.history.push((file.disk_version.clone(),file.base.take()));
                            if file.history.len() > 4 { file.history.remove(0); }
                            workspace.recent_saves.insert((capture.file_id.clone(),capture.expected_disk_version.clone(),version.clone()),capture.buffer_version);
                            if workspace.recent_saves.len() > MAX_FILES * 4 { workspace.recent_saves.pop_first(); }
                        }
                        file.base = capture.text.clone(); file.disk_version = version.clone(); file.conflict = None;
                    }
                    saved.push(json!({"fileId":capture.file_id,"bufferVersion":capture.buffer_version,"diskVersion":version}));
                }
                Err(error) => {
                    if error.code == "source_conflict" { if let Ok(actual) = workspace.root.read(&capture.path,SOURCE_DOCUMENT_BYTES) { if let Some(file) = workspace.files.get_mut(&capture.file_id) { let disk = actual.as_ref().and_then(|v| std::str::from_utf8(&v.bytes).ok()); let conflict = file.conflict_with(disk,actual.as_ref().map(|v| v.version.as_str())); file.conflict = Some(conflict.clone()); conflicts.push(conflict); } } }
                    failures.push(json!({"fileId":capture.file_id,"failure":error}));
                }
            }
        }
        trim_history(workspace);
        for resource in &mut workspace.resources {
            if resource["pendingSave"] != true { continue; }
            let result = (|| -> Result<Option<String>, Failure> {
                let path = field(resource,"path")?;
                let origin = workspace.asset_origin.as_ref().unwrap_or(&workspace.root);
                if origin.identity() == workspace.root.identity() { return Ok(resource["version"].as_str().map(str::to_owned)); }
                let content = origin.read(path,MAX_ASSETS as usize)?.ok_or_else(|| failure("changed_asset",format!("Imported asset disappeared: {path}")))?;
                if resource["version"].as_str() != Some(&content.version) { return Err(failure("changed_asset",format!("Imported asset changed: {path}"))); }
                workspace.root.write(path,Some(&content.bytes),None,self.storage.journal_dir())
            })();
            match result { Ok(version) => { resource["version"] = json!(version); resource.as_object_mut().expect("resource object").remove("pendingSave"); },Err(error) => failures.push(json!({"fileId":null,"failure":error})) }
        }
        let mut settings_saved = false;
        // Do not publish an entry/settings pointer when some requested content failed.
        if failures.is_empty() { match workspace.root.write(SETTINGS,Some(&settings_bytes),input.settings_disk_version.as_deref(),self.storage.journal_dir()) {
            Ok(version) => { workspace.settings_base = Some(String::from_utf8(settings_bytes).map_err(|_| failure("invalid_source","Settings encoding failed"))?); workspace.settings_version = version; workspace.settings_conflict = None; settings_saved = true; },
            Err(error) => failures.push(json!({"fileId":null,"failure":error})),
        } }
        if !saved.is_empty() || settings_saved { workspace.disk_generation = workspace.disk_generation.checked_add(1).ok_or_else(|| failure("resource_budget", "Disk generation exhausted"))?; }
        if !workspace.resources.iter().any(|resource| resource["pendingSave"] == true) { workspace.asset_origin = None; }
        if let Err(error) = self.record_recent(workspace) { failures.push(json!({"fileId":null,"failure":error})); }
        let mut result = json!({"saved":saved,"conflicts":conflicts,"failures":failures,"settingsDiskVersion":workspace.settings_version,"settingsSaved":settings_saved,"diskGeneration":workspace.disk_generation.to_string()});
        let snapshot = workspace.snapshot(); drop(guard);
        if let Err(error) = self.persist_current() { result["failures"].as_array_mut().expect("save failures array").push(json!({"fileId":null,"failure":error})); }
        self.reclaim_private_workspaces();
        self.emit_changed(snapshot,"save"); Ok(result)
    }
    pub(super) fn capture_sources(&mut self, capture: WorkingCapture) -> Result<Value,Failure> {
        self.acknowledge(&capture)?;
        let mut grants = io::boot_grants(&self.resource_dir,&self.event)?;
        grants.extend(self.grants.drain(..).filter(|grant| grant.id.starts_with("external:")));
        self.grants = grants;
        let state = self.state.clone(); let mut guard = state.lock(); let workspace = guard.as_mut().ok_or_else(|| failure("stale_request", "No open project"))?;
        if rescan(workspace)? { let snapshot = workspace.snapshot(); drop(guard); self.emit_changed(snapshot,"disk"); return Err(failure("source_conflict", "Disk changed during source capture; merge and recapture")); }
        if !workspace.conflicts().is_empty() { return Err(failure("source_conflict", "Resolve source conflicts before building")); }
        if !workspace.files.values().any(|f| f.path == capture.entry && f.text.is_some()) { return Err(failure("missing_module", "Selected entry is absent from the working sources")); }
        let mut files = Vec::new(); let mut baselines = Vec::new(); let mut bytes = 0usize;
        for file in workspace.files.values() {
            baselines.push((project_grant(&workspace.project),file.path.clone(),file.disk_version.clone()));
            if let Some(text) = &file.text { bytes += text.len(); files.push((json!({"fileId":file.id,"path":file.path,"bufferVersion":file.version,"diskVersion":file.disk_version,"bytes":text.len()}),text.clone())); }
        }
        baselines.push((project_grant(&workspace.project),SETTINGS.into(),workspace.settings_version.clone()));
        let mut library_paths = BTreeSet::new();
        for grant in &self.grants {
            if grant.kind == "library" {
                for entry in grant.root.list_sources(MAX_FILES)? {
                    if text_kind(&entry.path) != Some("source") { continue; }
                    let absolute = grant.root.path().join(&entry.path).to_str().ok_or_else(|| failure("denied_path", "Library path is not UTF-8"))?.to_owned();
                    if !library_paths.insert(absolute.clone()) { continue; }
                    let file = grant.root.read(&entry.path,SOURCE_DOCUMENT_BYTES)?.ok_or_else(|| failure("source_conflict", "Library source disappeared during capture"))?;
                    bytes = bytes.checked_add(file.bytes.len()).ok_or_else(|| failure("too_large", "Source snapshot overflow"))?;
                    if bytes > SOURCE_SNAPSHOT_BYTES || files.len() >= MAX_FILES { return Err(failure("too_large", "Project plus imported library source capture exceeds the host budget")); }
                    let text = String::from_utf8(file.bytes).map_err(|_| failure("invalid_source", "Library source is not UTF-8"))?;
                    files.push((json!({"fileId":stable_file_id(&grant.id,&entry.path),"path":absolute,"bufferVersion":0,"diskVersion":file.version,"bytes":text.len()}),text));
                    baselines.push((grant.id.clone(),entry.path.clone(),Some(file.version)));
                }
            } else if grant.kind == "config" {
                if let Some(path) = &grant.exact { let version = grant.root.fingerprint(path,SOURCE_DOCUMENT_BYTES as u64)?; baselines.push((grant.id.clone(),path.clone(),version.clone())); self.watcher.observe(&workspace.epoch,grant.root.clone(),path.clone(),version)?; }
            }
        }
        if bytes > SOURCE_SNAPSHOT_BYTES { return Err(failure("too_large", "Source snapshot exceeds 64 MiB")); }
        // A second full baseline pass makes a changing multi-file capture fail closed.
        for (grant,path,expected) in &baselines { if self.dependency_version(workspace,grant,path)? != *expected { return Err(failure("source_conflict",format!("Dependency changed during capture: {path}"))); } }
        let id = opaque();
        let descriptor = json!({"id":id,"project":workspace.project,"epoch":workspace.epoch,"sourceVersion":workspace.source_version,"entry":workspace.settings.entry,"diskGeneration":workspace.disk_generation.to_string(),"files":files.iter().map(|(f,_)|json!({"fileId":f["fileId"],"path":f["path"],"bufferVersion":f["bufferVersion"],"diskVersion":f["diskVersion"]})).collect::<Vec<_>>()});
        let root = workspace.root.path().to_owned();
        drop(guard);
        while self.snapshots.len() >= 4 || self.snapshots.values().map(|s| s.bytes).sum::<usize>() + bytes > SOURCE_SNAPSHOT_BYTES * 4 {
            let position = self.snapshot_order.iter().position(|old| self.retained.as_ref() != Some(old) && self.previous_snapshot.as_ref() != Some(old)).ok_or_else(|| failure("resource_budget", "Accepted snapshots occupy the source retention budget"))?;
            if let Some(old) = self.snapshot_order.remove(position) { self.snapshots.remove(&old); }
        }
        self.snapshots.insert(id.clone(),CapturedSnapshot { descriptor:descriptor.clone(),root,files,baselines,bytes,dependencies:Mutex::new(None) }); self.snapshot_order.push_back(id);
        Ok(descriptor)
    }
    pub(super) fn resolve_conflict(&mut self, input: &Value) -> Result<Value, Failure> {
        let state = self.state.clone(); let mut guard = state.lock(); let workspace = guard.as_mut().ok_or_else(|| failure("stale_request", "No open project"))?;
        workspace.assert_ref(field(input,"project")?,field(input,"epoch")?)?;
        let file_id = field(input,"fileId")?; let choice = field(input,"choice")?;
        let conflict = if file_id == "settings" { workspace.settings_conflict.clone() } else { workspace.files.get(file_id).and_then(|f| f.conflict.clone()) }.ok_or_else(|| failure("stale_request", "Conflict has already changed or been resolved"))?;
        if input.get("diskVersion") != conflict.get("diskVersion") { return Err(failure("source_conflict", "Conflict disk version changed")); }
        let disk = conflict["disk"].as_str().map(str::to_owned); let version = conflict["diskVersion"].as_str().map(str::to_owned); let path = field(&conflict,"path")?;
        if workspace.root.fingerprint(path,SOURCE_DOCUMENT_BYTES as u64)? != version { return Err(failure("source_conflict", "Disk changed again before conflict resolution")); }
        if !matches!(choice,"disk"|"local"|"merge") { return Err(failure("invalid_source", "Unknown conflict choice")); }
        let merged = if choice == "merge" { let text = field(input,"mergedText")?; if text.len() > SOURCE_DOCUMENT_BYTES { return Err(failure("too_large", "Merged source exceeds 8 MiB")); } Some(text.to_owned()) } else { None };
        if file_id == "settings" {
            let text = match choice { "disk" => disk.clone(),"merge" => merged,_ => Some(String::from_utf8(workspace.settings.bytes()?).map_err(|_|failure("invalid_source","Settings encoding failed"))?) };
            if let Some(text) = text { let settings: Settings = serde_json::from_str(&text).map_err(|e| failure("invalid_source",e.to_string()))?; settings.validate()?; workspace.settings = settings; }
            workspace.settings_base = disk; workspace.settings_version = version; workspace.settings_conflict = None;
        } else {
            let file = workspace.files.get_mut(file_id).ok_or_else(|| failure("stale_request", "File disappeared"))?;
            if choice == "disk" { file.text = disk.clone(); } else if choice == "merge" { file.text = merged; }
            file.base = disk; file.disk_version = version; file.conflict = None; file.version = file.version.checked_add(1).filter(|v| *v <= MAX_SAFE).ok_or_else(||failure("resource_budget","Buffer version exhausted"))?;
        }
        workspace.source_version = workspace.source_version.checked_add(1).filter(|v| *v <= MAX_SAFE).ok_or_else(|| failure("resource_budget", "Source version exhausted"))?;
        let snapshot = workspace.snapshot(); drop(guard); self.persist_current()?; self.emit_changed(snapshot.clone(),"conflict"); Ok(snapshot)
    }
    pub(super) fn persist_current(&mut self) -> Result<(),Failure> {
        let state = self.state.clone(); let guard = state.lock(); let workspace = guard.as_ref().ok_or_else(|| failure("stale_request", "No open project"))?;
        if workspace.persisted && !workspace.dirty() {
            let id = workspace.project.clone(); drop(guard);
            self.storage.remove_recovery(&id)?; self.offers.retain(|v| v["id"] != id); return Ok(());
        }
        let record = recovery_record(workspace,&self.grants);
        drop(guard);
        self.storage.put_recovery(&record)?;
        let offer = offer(&record); self.offers.retain(|v| v["id"] != record["id"]); self.offers.push(offer.clone());
        (self.event)(json!({"kind":"recovery","offer":offer})); Ok(())
    }
    pub(super) fn restore_recovery(&mut self, input: &Value) -> Result<Value,Failure> {
        let id = field(input,"id")?;
        match field(input,"action")? {
            "discard" => { self.storage.remove_recovery(id)?; self.offers.retain(|v| v["id"] != id); self.reclaim_private_workspaces(); return Ok(Value::Null); },
            "restore" => self.check_replacement()?, _ => return Err(failure("invalid_source", "Unknown recovery action")),
        }
        let record = self.storage.recovery_records()?.into_iter().find(|r| r["id"] == id).ok_or_else(|| failure("stale_request", "Recovery draft is no longer available"))?;
        let capture: WorkingCapture = decode(record["capture"].clone())?;
        let mut workspace = self.unsaved(capture.settings.clone(),Some(capture.project.clone()))?;
        workspace.gist = record["gist"].as_str().map(str::to_owned);
        if let Some(path) = record["root"].as_str() { if let Ok(root) = Root::open(Path::new(path)) { if record["rootIdentity"] == root.identity() { workspace.root = Arc::new(root); workspace.persisted = record["persisted"].as_bool().unwrap_or(!record["rootLabel"].is_null()); } } }
        if let Some(path) = record["assetOrigin"].as_str() { if let Ok(root) = Root::open(Path::new(path)) { workspace.asset_origin = Some(Arc::new(root)); } }
        workspace.source_version = capture.source_version; workspace.disk_generation = capture.expected_disk_generation.parse().map_err(|_|failure("invalid_source","Invalid recovery disk generation"))?;
        workspace.settings_base = record["settingsBase"].as_str().map(str::to_owned); workspace.settings_version = capture.settings_disk_version;
        for file in capture.buffers {
            let base = record["baseFiles"].as_array().and_then(|rows| rows.iter().find(|b| b["fileId"] == file.file_id));
            workspace.files.insert(file.file_id.clone(),Buffer { id:file.file_id,path:file.path,text:file.text,version:file.buffer_version,base:base.and_then(|b|b["text"].as_str()).map(str::to_owned),disk_version:file.expected_disk_version,conflict:None,history:Vec::new() });
        }
        workspace.resources = record["resources"].as_array().cloned().unwrap_or_default();
        let mut restored_grants = Vec::new();
        if let Some(rows) = record["externalGrants"].as_array() {
            if rows.len() > MAX_FILES { return Err(failure("resource_budget", "Too many recovery library grants")); }
            for row in rows {
                let id = field(row,"id")?; let path = field(row,"path")?;
                if !id.starts_with("external:") { return Err(failure("denied_path", "Invalid recovery library grant identity")); }
                match Root::open(Path::new(path)) {
                    Ok(root) if row["identity"] == root.identity() => { let root = Arc::new(root); restored_grants.push(Grant { id:id.into(),kind:"library",path:root.path().to_owned(),root,exact:None }); },
                    _ => { if let Some(resource) = workspace.resources.iter_mut().find(|r| r["id"] == id) { resource["availability"] = json!({"available":false,"reason":"Previously authorized library is missing or replaced; select it again"}); } }
                }
            }
        }
        rescan(&mut workspace)?;
        let result = self.install(workspace)?; self.grants.extend(restored_grants); self.persist_current()?; self.emit_changed(result.clone(),"recovery"); Ok(result)
    }
    pub(super) fn archive(&mut self, capture: WorkingCapture) -> Result<Value,Failure> {
        self.acknowledge(&capture)?;
        let name = format!("{}.zip",safe_filename(&capture.settings.title));
        let Some(destination) = rfd::FileDialog::new().set_title("Archive working project").set_file_name(&name).add_filter("ZIP archive", &["zip"]).save_file() else { return Err(failure("cancelled", "Archive destination selection cancelled")); };
        let staged = stage_export(&destination)?;
        let state = self.state.clone(); let guard = state.lock(); let workspace = guard.as_ref().ok_or_else(|| failure("stale_request", "No open project"))?;
        if workspace.working_capture().source_version != capture.source_version { return Err(failure("stale_request", "Project changed while choosing archive destination")); }
        io::write_archive(workspace,staged.staged_path())?;
        let linked: Vec<Value> = workspace.resources.iter().filter(|r|r["linked"]==true).map(public_resource).collect(); drop(guard);
        staged.publish()?;
        Ok(json!({"name":destination.file_name().map(|v|v.to_string_lossy().into_owned()).unwrap_or(name),"linkedResources":linked}))
    }
    pub(super) fn reveal(&self, input: &Value) -> Result<Value,Failure> {
        let guard = self.state.lock(); let workspace = guard.as_ref().ok_or_else(|| failure("stale_request", "No open project"))?;
        workspace.assert_ref(field(input,"project")?,field(input,"epoch")?)?; workspace.root.healthy()?;
        let (path,folder) = if input["id"].is_null() { (workspace.root.path().to_owned(),true) }
        else if let Some(grant) = self.grants.iter().find(|grant| input["id"] == grant.id) {
            grant.root.healthy()?;
            if let Some(exact) = &grant.exact {
                if grant.root.fingerprint(&grant.relative(exact)?,MAX_ASSETS)?.is_none() { return Err(failure("project_missing","Authorized file is missing")); }
                (grant.root.path().join(exact),false)
            } else { (grant.root.path().to_owned(),true) }
        } else {
            let id = field(input,"id")?;
            let relative = workspace.files.get(id).map(|f|f.path.as_str()).or_else(||workspace.resources.iter().find(|r|r["id"]==id).and_then(|r|r["path"].as_str())).ok_or_else(||failure("denied_path","Unknown reveal identity"))?;
            secure_fs::validate_path(relative)?;
            if workspace.root.fingerprint(relative,MAX_ASSETS)?.is_none() { return Err(failure("project_missing","File has not been saved")); }
            (workspace.root.path().join(relative),false)
        };
        drop(guard);
        #[cfg(target_os="linux")] { run_file_manager(&mut file_manager_command(&path,folder)?,std::time::Duration::from_secs(4))?; }
        #[cfg(not(target_os="linux"))] { let _ = (path,folder); return Err(failure("unsupported_platform","Native reveal is currently supported on Linux")); }
        Ok(Value::Null)
    }
    pub(super) fn prepare_close(&mut self, input: &Value, active_exports: u64) -> Result<Value,Failure> {
        // A failed renewed close attempt must not leave an earlier token usable.
        self.permit = None; self.allow_exit = false;
        let capture: WorkingCapture = decode(input["capture"].clone())?;
        self.acknowledge(&capture)?;
        let decision = field(input,"decision")?; let reason = field(input,"reason")?;
        if !matches!(reason,"replaceProject"|"closeProject"|"closeWindow"|"quit") || !matches!(decision,"save"|"discard"|"cancel") { return Err(failure("invalid_source","Invalid close decision")); }
        if decision == "cancel" { self.permit = None; return Ok(json!({"allowed":false,"token":null,"save":null,"failure":null})); }
        if matches!(reason,"closeWindow"|"quit") && input["ticket"].as_str() != self.close_ticket.as_deref() { return Err(failure("stale_request","Native close ticket expired")); }
        if active_exports > 0 { return Ok(json!({"allowed":false,"token":null,"save":null,"failure":Failure::new("queue_full","export","Active exports must finish or be cancelled")})); }
        let mut save = Value::Null;
        if decision == "save" {
            match self.save(SaveInput { project:capture.project.clone(),epoch:capture.epoch.clone(),files:capture.buffers.clone(),settings:capture.settings.clone(),settings_disk_version:capture.settings_disk_version.clone() },Some(capture.source_version)) {
                Ok(result) => { let complete = result["settingsSaved"] == true && result["failures"].as_array().is_some_and(Vec::is_empty) && result["conflicts"].as_array().is_some_and(Vec::is_empty); save = result; if !complete { return Ok(json!({"allowed":false,"token":null,"save":save,"failure":failure("source_conflict","Project was not completely saved")})); } },
                Err(error) => return Ok(json!({"allowed":false,"token":null,"save":null,"failure":error})),
            }
        } else { self.persist_current()?; }
        let guard = self.state.lock(); let workspace = guard.as_ref().ok_or_else(||failure("stale_request","No open project"))?;
        if !workspace.conflicts().is_empty() { return Ok(json!({"allowed":false,"token":null,"save":save,"failure":failure("source_conflict","Resolve disk conflicts before closing")})); }
        let token = opaque(); self.permit = Some(ClosePermit { token:token.clone(),fingerprint:workspace_fingerprint(workspace),reason:reason.into(),ticket:input["ticket"].as_str().map(str::to_owned),decision:decision.into() });
        Ok(json!({"allowed":true,"token":token,"save":save,"failure":null}))
    }
    pub(super) fn close(&mut self, input: &Value) -> Result<Value,Failure> {
        let state = self.state.clone(); let mut guard = state.lock(); let workspace = guard.as_ref().ok_or_else(||failure("stale_request","No open project"))?;
        workspace.assert_ref(field(input,"project")?,field(input,"epoch")?)?;
        let permit = self.permit.as_ref().ok_or_else(||failure("close_required","A matching close approval is required"))?;
        if field(input,"token")? != permit.token || workspace_fingerprint(workspace) != permit.fingerprint || (matches!(permit.reason.as_str(),"closeWindow"|"quit") && permit.ticket != self.close_ticket) { return Err(failure("stale_request","Close approval expired after edits or disk changes")); }
        let permit = self.permit.take().ok_or_else(||failure("close_required","Close token was consumed"))?;
        if permit.reason == "replaceProject" { self.replacement = Some(permit.fingerprint); }
        else {
            if permit.decision == "discard" && matches!(permit.reason.as_str(),"closeWindow"|"quit") { self.storage.remove_recovery(&workspace.project)?; self.offers.retain(|v|v["project"] != workspace.project); }
            self.allow_exit = matches!(permit.reason.as_str(),"closeWindow"|"quit");
            *guard = None; self.retained = None; self.previous_snapshot = None; self.snapshots.clear(); self.snapshot_order.clear(); self.replacement = None;
        }
        drop(guard);
        self.reclaim_private_workspaces();
        Ok(Value::Null)
    }
}
fn safe_filename(title: &str) -> String { let name: String = title.chars().filter(|c|c.is_alphanumeric() || matches!(c,'-'|'_'|' ')).take(100).collect(); if name.trim().is_empty() { "project".into() } else { name } }

pub(super) fn recovery_record(workspace: &Workspace, grants: &[Grant]) -> Value {
    with_gist(json!({"version":1,"id":workspace.project,"project":workspace.project,"title":workspace.settings.title,"rootLabel":workspace.root_label(),"root":workspace.root.path(),"rootIdentity":workspace.root.identity(),"persisted":workspace.persisted,"updatedAt":storage::timestamp(),"updatedMillis":storage::now_millis(),"capture":workspace.working_capture(),"baseFiles":workspace.files.values().map(|f|json!({"fileId":f.id,"path":f.path,"text":f.base,"diskVersion":f.disk_version})).collect::<Vec<_>>(),"settingsBase":workspace.settings_base,"resources":workspace.resources,"assetOrigin":workspace.asset_origin.as_ref().map(|r|r.path()),"externalGrants":grants.iter().filter(|g|g.id.starts_with("external:")).map(|g|json!({"id":g.id,"path":g.root.path(),"identity":g.root.identity()})).collect::<Vec<_>>()}), workspace.gist.as_deref())
}

#[cfg(target_os="linux")]
pub(super) fn file_manager_command(path: &Path, folder: bool) -> Result<std::process::Command,Failure> {
    let uri = url::Url::from_file_path(path).map_err(|_| failure("denied_path","Reveal requires an absolute local file identity"))?;
    let uris = format!("[{}]",serde_json::to_string(uri.as_str()).map_err(|error|failure("invalid_source",error.to_string()))?);
    let mut command = std::process::Command::new("gdbus");
    command.args(["call","--session","--dest","org.freedesktop.FileManager1","--object-path","/org/freedesktop/FileManager1","--method",
        if folder { "org.freedesktop.FileManager1.ShowFolders" } else { "org.freedesktop.FileManager1.ShowItems" },"--timeout","3"]);
    command.arg(uris).arg("");
    Ok(command)
}

#[cfg(target_os="linux")]
pub(super) fn run_file_manager(command: &mut std::process::Command, timeout: std::time::Duration) -> Result<(),Failure> {
    let unavailable = || failure("file_manager_unavailable","Reveal requires a running desktop file manager supporting org.freedesktop.FileManager1 on the session bus");
    let mut child = command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().map_err(|_|unavailable())?;
    let deadline = std::time::Instant::now()+timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { Ok(()) } else { Err(unavailable()) },
            Ok(None) if std::time::Instant::now()<deadline => std::thread::sleep(std::time::Duration::from_millis(10)),
            _ => { let _ = child.kill(); let _ = child.wait(); return Err(unavailable()); }
        }
    }
}
