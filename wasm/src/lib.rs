//! Small message/PCM ABI: no JS host calls, filesystem emulation, or shared memory.
use anyhow::{Result, bail, ensure};
use muz::{
    Session,
    audio::{AudioConfig, AudioEngine},
    lang::SourceLoader,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
    rc::Rc,
};

struct Files(BTreeMap<String, String>);
impl SourceLoader for Files {
    fn resolve(&self, path: &Path) -> Result<PathBuf> {
        let mut out = PathBuf::new();
        for part in path.components() {
            match part {
                Component::Normal(p) => out.push(p),
                Component::CurDir => {}
                Component::ParentDir => ensure!(out.pop(), "import escapes the project"),
                _ => bail!("absolute imports are unavailable; open the containing project folder"),
            }
        }
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

/// Control JSON omits performed events. Transfer them explicitly between workers.
#[derive(Serialize, Deserialize)]
struct Snapshot {
    session: Session,
    events: BTreeMap<String, muz::midi::ImportedMidi>,
}
#[derive(Default)]
struct Host {
    engine: Option<AudioEngine>,
    pcm: Vec<f32>,
    analysis: Vec<f32>,
    response: Vec<u8>,
    tail_frames: u64,
    ended_frames: u64,
}
thread_local! { static HOST: RefCell<Host> = RefCell::new(Host::default()); }

impl Host {
    fn call(&mut self, v: Value) -> Result<Value> {
        match v["command"].as_str().unwrap_or("") {
            "compile" | "check_entry" => {
                let files: BTreeMap<String, String> = serde_json::from_value(v["files"].clone())?;
                let entry = v["entry"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("choose an entry file"))?;
                let c = muz::compile::compile_with_loader(Path::new(entry), Rc::new(Files(files)))?;
                if v["command"] == "check_entry" {
                    return Ok(json!({"valid": true}));
                }
                let events = c
                    .session
                    .tracks
                    .iter()
                    .filter_map(|t| match &t.source {
                        muz::model::TrackSource::Midi(m) => {
                            Some((t.id.to_string(), m.imported.clone()))
                        }
                        _ => None,
                    })
                    .collect();
                let views = json!({
                    "graph": muz::inspect::session(&c.session, "graph")?,
                    "performance": muz::inspect::session(&c.session, "performance")?,
                    "patches": muz::inspect::session(&c.session, "patches")?,
                    "locations": c.locations,
                    "diagnostics": c.diagnostics,
                });
                Ok(json!({"snapshot": Snapshot { session: c.session, events }, "views": views}))
            }
            "load" => {
                let mut snapshot: Snapshot = serde_json::from_value(v["snapshot"].clone())?;
                for t in &mut snapshot.session.tracks {
                    if let muz::model::TrackSource::Midi(m) = &mut t.source {
                        m.imported =
                            snapshot.events.remove(&t.id.to_string()).ok_or_else(|| {
                                anyhow::anyhow!("snapshot is missing performed track {}", t.id)
                            })?;
                    }
                }
                let rate = v["rate"].as_f64().unwrap_or(48000.0);
                ensure!(
                    rate.is_finite() && (8000.0..=192000.0).contains(&rate),
                    "unsupported sample rate"
                );
                let candidate = AudioEngine::new(
                    &snapshot.session,
                    AudioConfig {
                        sample_rate: rate as f32,
                        max_frames: 1024,
                        offline: true,
                    },
                )?;
                self.tail_frames = (snapshot.session.extras.tail * rate).max(0.0) as u64;
                self.ended_frames = 0;
                self.engine = Some(candidate);
                self.pcm.resize(2048, 0.0);
                self.analysis.resize(2048, 0.0);
                self.status()
            }
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
                e.render_interleaved(&mut self.pcm[..frames * 2], 2)?;
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
    fn status(&self) -> Result<Value> {
        let s = self
            .engine
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("no accepted project"))?
            .status();
        Ok(
            json!({"beat": s.transport.beat_position, "seconds": s.transport.project_frame / s.transport.sample_rate,
            "endBeat": s.end_tick as f64 / muz::compile::PPQ as f64,
            "duration": s.end_project_frame / s.transport.sample_rate, "peak": s.last_peak, "rms": s.last_rms,
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
        let result = serde_json::from_slice(input).map_err(anyhow::Error::from).and_then(|v| h.call(v));
        let value = match result {
            Ok(value) => json!({"ok": true, "value": value}),
            Err(e) => json!({"ok": false, "error": e.downcast_ref::<muz::lang::Diagnostic>().map(|d| d.to_json()).unwrap_or_else(|| json!({"message": format!("{e:#}")}))}),
        };
        h.response = serde_json::to_vec(&value).unwrap();
        h.response.len()
    })
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
