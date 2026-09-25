//! Small message/PCM ABI: no JS host calls, filesystem emulation, or shared memory.
use anyhow::{Result, bail, ensure};
use muz::{
    Session,
    audio::{AudioConfig, AudioEngine},
    lang::SourceLoader,
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
    rc::Rc,
    sync::Arc,
};

struct Files(BTreeMap<String, String>);
fn project_path(path: &Path) -> Result<PathBuf> {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            Component::ParentDir => ensure!(out.pop(), "import escapes the project"),
            _ => bail!("absolute imports are unavailable; open the containing project folder"),
        }
    }
    Ok(out)
}
struct BrowserAssets(muz::assets::MemoryAssets);
impl muz::assets::AssetResolver for BrowserAssets {
    fn resolve(&self, path: &Path) -> Result<PathBuf> {
        self.0.resolve(&project_path(path)?)
    }
    fn version(&self, path: &Path) -> Result<(u64, u128)> {
        self.0.version(&project_path(path)?)
    }
    fn open(&self, path: &Path) -> Result<Box<dyn muz::assets::AssetReader>> {
        self.0.open(&project_path(path)?)
    }
    fn snapshot(&self, path: &Path, max: usize) -> Result<muz::assets::AssetSnapshot> {
        self.0.snapshot(&project_path(path)?, max)
    }
}
impl SourceLoader for Files {
    fn resolve(&self, path: &Path) -> Result<PathBuf> {
        let out = project_path(path)?;
        ensure!(
            self.0.contains_key(&out.to_string_lossy().to_string()),
            "module '{}' is not in the opened project or bundled library",
            out.display()
        );
        Ok(out)
    }
    fn read(&self, path: &Path) -> Result<String> {
        self.0
            .get(&path.to_string_lossy().to_string())
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("missing module {}", path.display()))
    }
    fn contrib_root(&self) -> Result<PathBuf> {
        Ok("contrib".into())
    }
}

struct Pending {
    request: u64,
    generation: u64,
    session: Session,
    context: muz::host::HostContext,
    config: AudioConfig,
    transaction: Option<muz::audio::transaction::PreparedTransaction>,
    initial: Option<AudioEngine>,
    effect: muz::audio::transaction::PreparationEffect,
}
#[derive(Default)]
struct Host {
    muted: Vec<String>,
    solo: Vec<String>,
    engine: Option<AudioEngine>,
    session: Option<Session>,
    context: muz::host::HostContext,
    pending: Option<Pending>,
    config: Option<AudioConfig>,
    generation: u64,
    revision: u64,
    compile_revision: u64,
    candidate: Option<(u64, muz::compile::Compiled)>,
    accepted: Option<(u64, muz::compile::Compiled)>,
    previous: Option<(u64, muz::compile::Compiled)>,
    assets: BTreeMap<String, (String, Arc<[u8]>, u128)>,
    upload: Option<Arc<[u8]>>,
    fade: Option<muz::audio::engine::EngineFade>,
    pcm: Vec<f32>,
    analysis: Vec<f32>,
    response: Vec<u8>,
    tail_frames: u64,
    ended_frames: u64,
}
thread_local! { static HOST: RefCell<Host> = RefCell::new(Host::default()); }

impl Host {
    fn compilation(&self, revision: u64) -> Result<&muz::compile::Compiled> {
        self.candidate
            .as_ref()
            .into_iter()
            .chain(self.accepted.as_ref())
            .find(|(r, _)| *r == revision)
            .map(|(_, c)| c)
            .ok_or_else(|| anyhow::anyhow!("stale inspection revision {revision}"))
    }
    fn call(&mut self, v: Value) -> Result<Value> {
        match v["command"].as_str().unwrap_or("") {
            "asset_put" => {
                let path = v["path"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("missing asset path"))?;
                ensure!(
                    !path.is_empty()
                        && !path.contains('\\')
                        && !path.contains(':')
                        && path
                            .split('/')
                            .all(|p| !p.is_empty() && p != "." && p != ".."),
                    "asset path must be project-relative"
                );
                let version = v["version"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("missing asset version"))?;
                let hex = version
                    .strip_prefix("sha256:")
                    .ok_or_else(|| anyhow::anyhow!("invalid asset version"))?;
                ensure!(
                    hex.len() == 64 && hex.bytes().all(|c| c.is_ascii_hexdigit()),
                    "invalid asset version"
                );
                // These versions cross JSON/JS numbers: retain exact 52-bit
                // tokens and reject a detected digest-prefix collision.
                let token = u128::from_str_radix(&hex[..13], 16)?;
                ensure!(
                    self.assets
                        .values()
                        .all(|(v, _, t)| *t != token || v == version),
                    "asset revision token collision"
                );
                let bytes = self
                    .upload
                    .take()
                    .ok_or_else(|| anyhow::anyhow!("upload asset bytes first"))?;
                ensure!(bytes.len() <= 16_000_000, "asset exceeds 16 MB");
                ensure!(
                    self.assets.len() < 256 || self.assets.contains_key(path),
                    "too many assets"
                );
                let existing = self.assets.get(path).map_or(0, |(_, b, _)| b.len());
                ensure!(
                    self.assets.values().map(|(_, b, _)| b.len()).sum::<usize>() - existing
                        + bytes.len()
                        <= 64_000_000,
                    "assets exceed 64 MB"
                );
                self.assets
                    .insert(path.into(), (version.into(), bytes, token));
                Ok(json!({"stored":true}))
            }
            "asset_prune" => {
                let entries = v["entries"]
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("asset manifest required"))?;
                self.assets.retain(|path, (version, _, _)| {
                    entries.iter().any(|e| {
                        e["path"].as_str() == Some(path) && e["version"].as_str() == Some(version)
                    })
                });
                Ok(json!({"pruned":true}))
            }
            "asset_manifest" => {
                let entries = v["entries"]
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("asset manifest required"))?;
                ensure!(entries.len() <= 256, "too many assets");
                let mut memory = muz::assets::MemoryAssets::default();
                let mut keep = std::collections::BTreeSet::new();
                for entry in entries {
                    let path = entry["path"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("asset path required"))?;
                    ensure!(keep.insert(path.to_owned()), "duplicate asset path");
                    let (version, bytes, token) = self
                        .assets
                        .get(path)
                        .ok_or_else(|| anyhow::anyhow!("missing asset {path}"))?;
                    ensure!(
                        entry["version"].as_str() == Some(version),
                        "asset version mismatch: {path}"
                    );
                    memory.insert(path.into(), bytes.clone(), *token);
                }
                self.context = muz::host::HostContext {
                    provenance: true,
                    assets: Arc::new(BrowserAssets(memory)),
                    ..Default::default()
                };
                self.assets.retain(|path, _| keep.contains(path));
                Ok(json!({"assets":keep.len()}))
            }
            "compile" | "check_entry" => {
                self.context.provenance = true;
                let files: BTreeMap<String, String> = serde_json::from_value(v["files"].clone())?;
                let entry = v["entry"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("choose an entry file"))?;
                let c = muz::compile::compile_with_context(
                    Path::new(entry),
                    Rc::new(Files(files)),
                    &self.context,
                )?;
                if v["command"] == "check_entry" {
                    return Ok(json!({"valid": true}));
                }
                self.compile_revision += 1;
                let snapshot = self
                    .context
                    .run(|| muz::snapshot::PlayableSnapshotV1::capture(&c.session))?;
                let summary =
                    muz::snapshot::SessionSummary::new(&c.session, self.compile_revision)?;
                let effect = self
                    .accepted
                    .as_ref()
                    .map(|(_, old)| {
                        let plan = muz::plan_reconciliation(0, &old.session, &c.session)?;
                        Ok::<_, anyhow::Error>(muz::audio::transaction::preparation_effect(
                            &old.session,
                            &c.session,
                            &plan,
                        ))
                    })
                    .transpose()?;
                self.previous = None;
                self.candidate = Some((self.compile_revision, c));
                Ok(
                    json!({"revision":self.compile_revision,"snapshot":snapshot,"summary":summary,"effect":effect}),
                )
            }
            "inspect" | "explain" | "diff" | "location" => {
                let revision = v["revision"]
                    .as_u64()
                    .ok_or_else(|| anyhow::anyhow!("revision required"))?;
                let c = self.compilation(revision)?;
                let r: muz::inspect::PageRequest =
                    serde_json::from_value(v.get("page").cloned().unwrap_or(json!({})))?;
                ensure!(
                    r.revision.is_none_or(|r| r == revision),
                    "stale page revision"
                );
                match v["command"].as_str().unwrap() {
                    "inspect" => Ok(serde_json::to_value(muz::inspect::page_compiled(
                        c,
                        revision,
                        v["view"].as_str().unwrap_or("summary"),
                        &r,
                    )?)?),
                    "location" => {
                        let location = c.locations.get(v["key"].as_str().unwrap_or(""));
                        let bytes = serde_json::to_vec(&location)?;
                        ensure!(
                            bytes.len() <= 1024 * 1024,
                            "source location exceeds page limit"
                        );
                        Ok(json!({"revision":revision,"location":location}))
                    }
                    "explain" => {
                        let track = v["track"].as_str().unwrap_or("");
                        let (offset, limit) = if let Some(key) = v["key"].as_str() {
                            let t = c
                                .score
                                .iter()
                                .find(|t| t.id == track)
                                .ok_or_else(|| anyhow::anyhow!("unknown score track"))?;
                            let index = t
                                .pattern
                                .notes
                                .iter()
                                .position(|n| n.key == key)
                                .ok_or_else(|| anyhow::anyhow!("unknown note key"))?;
                            ensure!(
                                t.pattern.notes.iter().filter(|n| n.key == key).count() == 1,
                                "ambiguous note key"
                            );
                            (index, 1)
                        } else {
                            (r.offset, r.limit)
                        };
                        Ok(json!({"revision":revision,"page":c.explain_notes(track,offset,limit)?}))
                    }
                    _ => {
                        let old = if self.accepted.as_ref().is_some_and(|(r, _)| *r == revision) {
                            self.previous.as_ref()
                        } else {
                            self.accepted.as_ref()
                        }
                        .ok_or_else(|| anyhow::anyhow!("no accepted comparison revision"))?;
                        Ok(
                            json!({"revision":revision,"base_revision":old.0,"page":muz::provenance::diff_page(&old.1,c,v["category"].as_str().unwrap_or("notes"),r.offset,r.limit)?}),
                        )
                    }
                }
            }
            "accept_compilation" => {
                let revision = v["revision"].as_u64().unwrap_or(0);
                ensure!(
                    self.candidate.as_ref().is_some_and(|(r, _)| *r == revision),
                    "stale compilation acceptance"
                );
                self.previous = self.accepted.take();
                self.accepted = self.candidate.take();
                Ok(json!({"revision":revision}))
            }
            "export_midi" => {
                let bytes = serde_json::to_vec(&v["snapshot"])?;
                let session = self.context.run(|| {
                    muz::snapshot::PlayableSnapshotV1::decode_checked(
                        &bytes,
                        muz::snapshot::MAX_SNAPSHOT_BYTES,
                    )?
                    .restore_description()
                })?;
                let selected: Vec<String> = serde_json::from_value(v["tracks"].clone())?;
                ensure!(!selected.is_empty(), "select at least one MIDI track");
                let ids: Vec<_> = session
                    .tracks
                    .iter()
                    .filter(|t| matches!(t.source, muz::model::TrackSource::Midi(_)))
                    .map(|t| t.id.as_str())
                    .collect();
                ensure!(
                    selected.iter().all(|id| ids.contains(&id.as_str())),
                    "unknown MIDI track"
                );
                // Export before filtering so the conductor map is independent of selection.
                let mut doc = muz::smf::export(&session)?;
                doc.tracks = doc
                    .tracks
                    .into_iter()
                    .enumerate()
                    .filter(|(i, _)| *i == 0 || selected.iter().any(|id| id == ids[*i - 1]))
                    .map(|(_, track)| track)
                    .collect();
                Ok(json!({"bytes": muz::smf::encode(&doc)?}))
            }
            "load" | "prepare" => {
                self.pending = None;
                let bytes = serde_json::to_vec(&v["snapshot"])?;
                let session = self.context.run(|| {
                    muz::snapshot::PlayableSnapshotV1::decode_checked(
                        &bytes,
                        muz::snapshot::MAX_SNAPSHOT_BYTES,
                    )?
                    .restore_checked()
                })?;
                let rate = v["rate"].as_f64().unwrap_or(48000.0);
                ensure!(
                    rate.is_finite() && (8000.0..=192000.0).contains(&rate),
                    "unsupported sample rate"
                );
                let config = AudioConfig {
                    sample_rate: rate as f32,
                    max_frames: 1024,
                    offline: true,
                };
                ensure!(
                    self.config.is_none_or(|c| c == config),
                    "audio configuration changed; recreate renderer"
                );
                ensure!(
                    v.get("base_revision")
                        .and_then(Value::as_u64)
                        .is_none_or(|r| r == self.revision),
                    "stale base revision"
                );
                let (transaction, initial, effect) = if let Some(old) = &self.session {
                    let plan = muz::plan_reconciliation(self.revision, old, &session)?;
                    let effect = muz::audio::transaction::preparation_effect(old, &session, &plan);
                    let transaction = self.context.run(|| {
                        muz::audio::transaction::PreparedTransaction::prepare(
                            old,
                            &session,
                            &plan,
                            self.generation,
                            None,
                            config,
                        )
                    })?;
                    (Some(transaction), None, effect)
                } else {
                    (
                        None,
                        Some(self.context.run(|| AudioEngine::new(&session, config))?),
                        muz::audio::transaction::PreparationEffect::Structural,
                    )
                };
                let request = v["request"].as_u64().unwrap_or(0);
                self.pending = Some(Pending {
                    request,
                    generation: self.generation,
                    session,
                    context: self.context.clone(),
                    config,
                    transaction,
                    initial,
                    effect,
                });
                if v["command"] == "load" {
                    return self.commit(request);
                }
                Ok(
                    json!({"request":request,"base_revision":self.revision,"generation":self.generation,"effect":effect,"needs_fade":self.pending.as_ref().and_then(|p|p.transaction.as_ref()).is_some_and(|t|t.needs_fade())}),
                )
            }
            "apply" => self.commit(v["request"].as_u64().unwrap_or(0)),
            "discard" => {
                self.pending = None;
                Ok(json!({"discarded":true}))
            }
            "audition" => {
                let muted: Vec<String> = serde_json::from_value(v["muted"].clone())?;
                let solo: Vec<String> = serde_json::from_value(v["solo"].clone())?;
                let session = self
                    .session
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("rebuild a project first"))?;
                ensure!(
                    muted.len() <= session.tracks.len() && solo.len() <= session.tracks.len(),
                    "too many audition tracks"
                );
                ensure!(
                    muted
                        .iter()
                        .chain(&solo)
                        .all(|id| session.tracks.iter().any(|t| t.id.as_str() == id)),
                    "unknown audition track"
                );
                self.muted = muted;
                self.solo = solo;
                self.apply_audition(v["ramp"].as_bool().unwrap_or(true))?;
                Ok(json!({"muted":self.muted,"solo":self.solo}))
            }
            "status" => self.status(),
            "seek" => {
                let beat = v["beat"].as_f64().unwrap_or(0.0);
                ensure!(beat.is_finite() && beat >= 0.0, "invalid seek position");
                let e = self
                    .engine
                    .as_mut()
                    .ok_or_else(|| anyhow::anyhow!("rebuild a project first"))?;
                e.panic();
                e.seek_ticks(muz::compile::tick(beat));
                e.set_running(true);
                self.generation += 1;
                self.ended_frames = 0;
                self.status()
            }
            "loop" => {
                let e = self
                    .engine
                    .as_mut()
                    .ok_or_else(|| anyhow::anyhow!("rebuild a project first"))?;
                let range = if let Some(r) = v["range"].as_array() {
                    ensure!(r.len() == 2, "loop needs start and end");
                    let (a, b) = (r[0].as_f64().unwrap_or(-1.0), r[1].as_f64().unwrap_or(-1.0));
                    ensure!(
                        a.is_finite() && b.is_finite() && a >= 0.0 && b > a,
                        "loop end must follow start"
                    );
                    Some((muz::compile::tick(a), muz::compile::tick(b)))
                } else {
                    None
                };
                e.set_loop(range);
                self.generation += 1;
                self.ended_frames = 0;
                self.status()
            }
            "render" => {
                let frames = v["frames"].as_u64().unwrap_or(1024) as usize;
                ensure!(
                    (1..=1024).contains(&frames),
                    "render block must have 1..1024 frames"
                );
                let e = self
                    .engine
                    .as_mut()
                    .ok_or_else(|| anyhow::anyhow!("rebuild a project first"))?;
                let before = e.status();
                e.set_running(true);
                let fade = if v["fade_out"].as_bool() == Some(true) {
                    self.pending
                        .as_ref()
                        .and_then(|p| p.transaction.as_ref())
                        .and_then(|t| t.fade_out())
                } else {
                    self.fade.take()
                };
                e.render_interleaved_with_fade(&mut self.pcm[..frames * 2], 2, fade)?;
                self.analysis[..frames * 2].fill(0.0);
                if let Some(id) = v["analysis"].as_str() {
                    for i in 0..e.track_count() {
                        let (track, left, right, _) = e.track_audio(i);
                        if track == id {
                            for frame in 0..frames {
                                self.analysis[frame * 2] = left[frame];
                                self.analysis[frame * 2 + 1] = right[frame];
                            }
                            break;
                        }
                    }
                } else {
                    self.analysis[..frames * 2].copy_from_slice(&self.pcm[..frames * 2]);
                }
                if e.status().ended {
                    self.ended_frames += frames as u64;
                }
                let meters: Vec<_> = (0..e.track_count())
                    .map(|i| {
                        let (id, l, r, _) = e.track_audio(i);
                        let peak = l[..frames]
                            .iter()
                            .chain(&r[..frames])
                            .fold(0.0_f32, |a, b| a.max(b.abs()));
                        json!({"id": id, "peak": peak})
                    })
                    .collect();
                Ok(
                    json!({"startBeat": before.transport.beat_position, "startSeconds": before.transport.project_frame / before.transport.sample_rate,
                    "frames": frames, "meters": meters, "status": self.status()?}),
                )
            }
            "format" => Ok(
                json!({"source": muz::lang::format::format(v["source"].as_str().unwrap_or(""))?}),
            ),
            _ => bail!("unknown browser command"),
        }
    }
    fn commit(&mut self, request: u64) -> Result<Value> {
        let mut pending = self
            .pending
            .take()
            .ok_or_else(|| anyhow::anyhow!("no prepared revision"))?;
        ensure!(
            pending.request == request && pending.generation == self.generation,
            "stale prepared revision"
        );
        if let Some(transaction) = &mut pending.transaction {
            if let Err(error) = transaction.apply(self.engine.as_mut().unwrap()) {
                self.fade = transaction.fade_recovery();
                return Err(error.into());
            }
            self.revision = transaction.revision();
            self.fade = transaction.fade_in();
        } else {
            self.engine = pending.initial.take();
            self.revision = 0;
        }
        self.tail_frames =
            (pending.session.extras.tail * pending.config.sample_rate as f64).max(0.) as u64;
        self.ended_frames = 0;
        self.config = Some(pending.config);
        self.context = pending.context;
        self.session = Some(pending.session);
        self.apply_audition(false)?;
        self.pcm.resize(2048, 0.);
        self.analysis.resize(2048, 0.);
        let mut status = self.status()?;
        status["effect"] = serde_json::to_value(pending.effect)?;
        Ok(status)
    }
    fn apply_audition(&mut self, ramp: bool) -> Result<()> {
        let session = self.session.as_ref().unwrap();
        self.muted
            .retain(|id| session.tracks.iter().any(|t| t.id.as_str() == id));
        self.solo
            .retain(|id| session.tracks.iter().any(|t| t.id.as_str() == id));
        let audible = session
            .tracks
            .iter()
            .filter(|t| {
                !self.muted.iter().any(|id| t.id.as_str() == id)
                    && (self.solo.is_empty() || self.solo.iter().any(|id| t.id.as_str() == id))
            })
            .map(|t| t.id.to_string())
            .collect::<Vec<_>>();
        self.engine
            .as_mut()
            .unwrap()
            .set_track_audibility(&audible, ramp)?;
        Ok(())
    }
    fn status(&self) -> Result<Value> {
        let s = self
            .engine
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("no accepted project"))?
            .status();
        Ok(
            json!({"revision":self.revision,"generation":self.generation,"beat": s.transport.beat_position, "seconds": s.transport.project_frame / s.transport.sample_rate,
            "endBeat": s.end_tick as f64 / muz::compile::PPQ as f64,
            "duration": s.end_project_frame / s.transport.sample_rate, "latencyFrames": self.engine.as_ref().unwrap().latency_samples(), "peak": s.last_peak, "rms": s.last_rms,
            "bpm": s.transport.bpm, "meter": s.transport.meter,
            "done": s.ended && self.ended_frames >= self.tail_frames}),
        )
    }
}

// JS allocates an input buffer, writes UTF-8, calls request, then frees it. Results
// remain valid until the next request. PCM remains valid until load/render.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    unsafe {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn request(ptr: *const u8, len: usize) -> usize {
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    HOST.with_borrow_mut(|h| {
        let result = if len>muz::snapshot::MAX_SNAPSHOT_BYTES { Err(anyhow::anyhow!("browser request exceeds byte limit")) } else { serde_json::from_slice(input).map_err(anyhow::Error::from).and_then(|v| h.call(v)) };
        let value = match result {
            Ok(value) => json!({"ok": true, "value": value}),
            Err(e) => json!({"ok": false, "error": e.downcast_ref::<muz::lang::Diagnostic>().map(|d| d.to_json()).unwrap_or_else(|| json!({"message": format!("{e:#}")}))}),
        };
        h.response = serde_json::to_vec(&value).unwrap();
        h.response.len()
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn asset_bytes(ptr: *const u8, len: usize) -> u32 {
    if len > 16_000_000 {
        return 0;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    HOST.with_borrow_mut(|h| h.upload = Some(Arc::from(bytes)));
    1
}
#[unsafe(no_mangle)]
pub extern "C" fn response_ptr() -> *const u8 {
    HOST.with_borrow(|h| h.response.as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn pcm_ptr() -> *const f32 {
    HOST.with_borrow(|h| h.pcm.as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn analysis_ptr() -> *const f32 {
    HOST.with_borrow(|h| h.analysis.as_ptr())
}
