//! Offline jobs retain their accepted revision, never the live runtime or audition mask.
//! Only checked playable snapshots and immutable resolver pins cross into fixed-binary
//! workers. Worker audio/plugin construction happens on that process's main thread.
use super::{Accepted, sources};
use crate::protocol::{Context, Failure};
use anyhow::{Context as _, Result, bail, ensure};
use muz::{model::TrackSource, snapshot::PlayableSnapshotV1};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashSet, VecDeque},
    fs::File,
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering}},
    thread::{self, JoinHandle},
    time::Duration,
};

const WORKERS: usize = 2;
const QUEUE: usize = 32;
const BLOCK: usize = 256;
const REPORT_BYTES: usize = 64 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Spec {
    #[serde(rename = "masterWav")]
    MasterWav,
    #[serde(rename = "wav")]
    Wav { tracks: Vec<String>, rate: u32, bits: u16, start: f64, end: f64 },
    #[serde(rename = "midi")]
    Midi { tracks: Vec<String> },
}

pub enum ExportEvent {
    Progress {
        context: Context,
        job: String,
        reference: Value,
        phase: &'static str,
        progress: Option<f64>,
    },
    Finished {
        context: Context,
        job: String,
        reference: Value,
        result: std::result::Result<Value, Failure>,
    },
}

struct Job {
    snapshot: Option<PlayableSnapshotV1>,
    assets: Arc<sources::PinnedAssets>,
    reference: Value,
    context: Context,
    job: String,
    spec: Spec,
    staging: PathBuf,
}
impl Job {
    fn failure(&self, code: &str, message: impl Into<String>) -> Failure {
        failure(&self.context, code, message)
    }
    fn progress(&self, phase: &'static str, progress: Option<f64>) -> ExportEvent {
        ExportEvent::Progress {
            context: self.context.clone(), job: self.job.clone(),
            reference: self.reference.clone(), phase, progress,
        }
    }
    fn finished(self, result: std::result::Result<Value, Failure>) -> ExportEvent {
        ExportEvent::Finished {
            context: self.context, job: self.job,
            reference: self.reference, result,
        }
    }
}
#[derive(Default)]
struct Progress {
    phase: AtomicU8,
    done: AtomicU64,
    total: AtomicU64,
    cancelled: AtomicBool,
}
struct Active {
    job: Job,
    progress: Arc<Progress>,
    handle: JoinHandle<Result<()>>,
    last: (u8, u64, u64),
}

/// Poll from the coordinator. No worker IPC, filesystem I/O or plugin servicing
/// runs in poll; progress is coalesced, while every admitted outcome is retained.
#[derive(Default)]
pub struct Scheduler {
    queued: VecDeque<Job>,
    active: Vec<Active>,
    events: Vec<ExportEvent>,
    stopped: bool,
}
impl Scheduler {
    pub fn new() -> Self { Self::default() }

    pub fn submit(
        &mut self, accepted: Arc<Accepted>, spec: Value, context: Context,
        job: String, staging: PathBuf,
    ) -> std::result::Result<(), Failure> {
        if self.stopped {
            return Err(failure(&context, "cancelled", "export scheduler is stopped"));
        }
        // Reserve terminal capacity as well as the actual 32 waiting slots.
        if self.queued.len() >= QUEUE || self.events.len() >= (QUEUE + WORKERS) * 2 {
            return Err(failure(&context, "queue_full", "export queue is full"));
        }
        if self.queued.iter().any(|j| j.job == job || j.context.request_id == context.request_id)
            || self.active.iter().any(|a| a.job.job == job || a.job.context.request_id == context.request_id)
        {
            return Err(failure(&context, "invalid_source", "duplicate export identity"));
        }
        let spec: Spec = serde_json::from_value(spec)
            .map_err(|e| failure(&context, "invalid_source", e.to_string()))?;
        validate(&accepted.compiled.session, &spec)
            .map_err(|e| failure(&context, "invalid_source", e.to_string()))?;
        let assets = accepted.assets.clone();
        let capture = sources::context(assets.clone(), Arc::new(AtomicBool::new(false)));
        let snapshot = capture.run(|| PlayableSnapshotV1::capture(&accepted.compiled.session))
            .map_err(|e| failure(&context, "changed_asset", format!("{e:#}")))?;
        let job = Job {
            snapshot: Some(snapshot), assets, reference: accepted.reference.clone(),
            context, job, spec, staging,
        };
        self.events.push(job.progress("queued", Some(0.0)));
        self.queued.push_back(job);
        self.start_ready();
        Ok(())
    }

    fn start_ready(&mut self) {
        while !self.stopped && self.active.len() < WORKERS {
            let Some(mut job) = self.queued.pop_front() else { break };
            let progress = Arc::new(Progress::default());
            // Retain only the immutable playable capture, not Compiled: plugin
            // restart receipts may stamp the coordinator's accepted description.
            let snapshot = job.snapshot.take().expect("queued playable snapshot");
            let assets = job.assets.clone();
            let spec = job.spec.clone();
            let staging = job.staging.clone();
            let state = progress.clone();
            let handle = thread::Builder::new().name("muzpad-export".into()).spawn(move || {
                supervise(snapshot, assets, spec, &staging, &state)
            });
            match handle {
                Ok(handle) => {
                    self.events.push(job.progress("preparing", None));
                    self.active.push(Active { job, progress, handle, last: (0, 0, 0) });
                }
                Err(error) => {
                    let error = job.failure("child_died", error.to_string());
                    self.events.push(job.finished(Err(error)));
                }
            }
        }
    }

    pub fn poll(&mut self) -> Vec<ExportEvent> {
        let mut index = 0;
        while index < self.active.len() {
            let active = &self.active[index];
            if active.handle.is_finished() {
                let active = self.active.swap_remove(index);
                self.finish(active);
            } else {
                let active = &mut self.active[index];
                let phase = active.progress.phase.load(Ordering::Acquire);
                let done = active.progress.done.load(Ordering::Relaxed);
                let total = active.progress.total.load(Ordering::Relaxed);
                if (phase, done, total) != active.last {
                    active.last = (phase, done, total);
                    self.events.push(active.job.progress(
                        if phase == 0 { "preparing" } else { "rendering" },
                        (total > 0).then(|| (done as f64 / total as f64).clamp(0.0, 1.0)),
                    ));
                }
                index += 1;
            }
        }
        self.start_ready();
        std::mem::take(&mut self.events)
    }

    fn finish(&mut self, active: Active) {
        let result = active.handle.join().unwrap_or_else(|_| Err(anyhow::anyhow!("export supervisor panicked")));
        let result = if active.progress.cancelled.load(Ordering::Acquire) {
            // Parent owns staged-output cleanup and arbitrates cancellation before
            // destination publication, including a stage/cancel race.
            Err(active.job.failure("cancelled", "export cancelled"))
        } else {
            result.map(|()| json!({
                "job": active.job.job, "ref": active.job.reference,
                "stagedOutput": active.job.staging, "clipped": false,
            })).map_err(|error| {
                let code = if let Some(error) = error.downcast_ref::<WorkerFailure>() {
                    error.code.as_str()
                } else if let Some(error) = error.downcast_ref::<Failure>() {
                    error.code.as_str()
                } else { "file_write_failed" };
                active.job.failure(code, format!("{error:#}"))
            })
        };
        if result.is_ok() {
            self.events.push(active.job.progress("rendering", Some(1.0)));
            self.events.push(active.job.progress("publishing", Some(1.0)));
        }
        self.events.push(active.job.finished(result));
    }

    /// Accept either the originating request ID or the opaque export job ID.
    pub fn cancel(&mut self, target: &str) -> bool {
        if let Some(index) = self.queued.iter().position(|j| j.job == target || j.context.request_id == target) {
            let job = self.queued.remove(index).expect("located queued export");
            let error = job.failure("cancelled", "export cancelled");
            self.events.push(job.finished(Err(error)));
            return true;
        }
        if let Some(active) = self.active.iter().find(|a| a.job.job == target || a.job.context.request_id == target) {
            active.progress.cancelled.store(true, Ordering::Release);
            return true;
        }
        false
    }

    /// Shutdown is the only blocking scheduler operation: subprocesses are killed
    /// and reaped before pins are released and the child acknowledges shutdown.
    pub fn shutdown(&mut self) -> Vec<ExportEvent> {
        self.stopped = true;
        while let Some(job) = self.queued.pop_front() {
            let error = job.failure("cancelled", "export scheduler shut down");
            self.events.push(job.finished(Err(error)));
        }
        for active in &self.active {
            active.progress.cancelled.store(true, Ordering::Release);
        }
        while let Some(active) = self.active.pop() { self.finish(active); }
        std::mem::take(&mut self.events)
    }
}
impl Drop for Scheduler {
    fn drop(&mut self) { let _ = self.shutdown(); }
}

fn failure(context: &Context, code: &str, message: impl Into<String>) -> Failure {
    let mut error = Failure::new(code, "export", message.into());
    error.request_id = Some(context.request_id.clone());
    error.revision = context.revision.clone();
    error
}
fn validate(session: &muz::Session, spec: &Spec) -> Result<()> {
    let tracks = match spec {
        Spec::MasterWav => return Ok(()),
        Spec::Wav { tracks, rate, bits, start, end } => {
            ensure!(matches!(rate, 44100 | 48000 | 96000), "unsupported WAV sample rate");
            ensure!(matches!(bits, 16 | 24), "unsupported PCM bit depth");
            ensure!(start.is_finite() && end.is_finite() && *start >= 0.0 && end > start,
                "WAV range must be finite absolute seconds with end after start");
            ensure!(*end <= full_duration(session)? + 0.000001, "WAV range exceeds duration plus tail");
            ensure!(end - start <= 36000.0, "WAV duration exceeds ten hours");
            tracks
        }
        Spec::Midi { tracks } => tracks,
    };
    ensure!(!tracks.is_empty(), "select at least one physical track");
    let mut seen = HashSet::with_capacity(tracks.len());
    for id in tracks {
        ensure!(seen.insert(id), "duplicate export track {id}");
        let track = session.tracks.iter().find(|track| track.id.as_str() == id)
            .ok_or_else(|| anyhow::anyhow!("unknown physical export track {id}"))?;
        ensure!(!matches!(spec, Spec::Midi { .. }) || matches!(&track.source, TrackSource::Midi(_)),
            "track {id} has no performed MIDI events");
    }
    Ok(())
}
fn full_duration(session: &muz::Session) -> Result<f64> {
    let mut duration = 0.0_f64;
    for track in &session.tracks {
        if let TrackSource::Midi(source) = &track.source {
            ensure!(source.summary.ppq > 0, "invalid MIDI timebase");
            duration = duration.max(muz::compile::seconds_at(
                source.summary.end_tick as f64 / source.summary.ppq as f64,
                &source.imported.tempos,
            ));
        }
    }
    ensure!(session.extras.tail.is_finite() && (0.0..=600.0).contains(&session.extras.tail), "invalid render tail");
    let duration = duration + session.extras.tail;
    ensure!(duration.is_finite() && duration > 0.0 && duration <= 36000.0, "invalid render duration");
    Ok(duration)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerInput { spec: Spec }
#[derive(Debug, Serialize, Deserialize)]
struct WorkerFailure { code: String, message: String }
impl std::fmt::Display for WorkerFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.message) }
}
impl std::error::Error for WorkerFailure {}
#[derive(Serialize, Deserialize)]
struct WorkerReport { result: std::result::Result<(), WorkerFailure> }

struct RunningChild(Child);
impl Drop for RunningChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn check_cancel(progress: &Progress) -> Result<()> {
    ensure!(!progress.cancelled.load(Ordering::Acquire), "export cancelled");
    Ok(())
}
fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let file = File::open(path)?;
    ensure!(file.metadata()?.len() <= limit as u64, "export transfer exceeds byte limit");
    let mut data = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut data)?;
    ensure!(data.len() <= limit, "export transfer exceeds byte limit");
    Ok(data)
}

fn supervise(
    snapshot: PlayableSnapshotV1, assets: Arc<sources::PinnedAssets>, spec: Spec,
    staging: &Path, progress: &Progress,
) -> Result<()> {
    check_cancel(progress)?;
    let directory = sources::temporary_directory()?;
    let root = directory.path();
    let bytes = serde_json::to_vec(&snapshot)?;
    ensure!(bytes.len() <= muz::snapshot::MAX_SNAPSHOT_BYTES, "playable snapshot exceeds byte limit");
    std::fs::write(root.join("snapshot.json"), bytes)?;
    drop(snapshot);
    assets.write_transfer(&root.join("assets"))?;
    std::fs::write(root.join("input.json"), serde_json::to_vec(&WorkerInput { spec })?)?;
    check_cancel(progress)?;
    let mut command = Command::new(std::env::current_exe().context("locate fixed engine binary")?);
    command.arg("--export-worker").arg(root)
        .env_remove("MUZPAD_PROTOCOL_READ_FD").env_remove("MUZPAD_PROTOCOL_WRITE_FD")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id() as libc::pid_t;
        let protocol_fds = ["MUZPAD_PROTOCOL_READ_FD", "MUZPAD_PROTOCOL_WRITE_FD"].map(|key| {
            std::env::var(key).ok().and_then(|value| value.parse::<libc::c_int>().ok())
        });
        // Stay in the supervisor-owned process group, but also die if the engine
        // disappears between supervisor lifecycle checks. Only async-signal-safe
        // operations run between fork and exec.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    return Err(std::io::Error::from_raw_os_error(libc::ECANCELED));
                }
                for descriptor in protocol_fds.into_iter().flatten().filter(|fd| *fd > 2) {
                    libc::close(descriptor);
                }
                Ok(())
            });
        }
    }
    let mut child = RunningChild(command.spawn().map_err(|error| WorkerFailure {
        code: "child_died".into(), message: format!("start independent export worker: {error}"),
    })?);
    loop {
        check_cancel(progress)?;
        if let Ok(bytes) = read_bounded(&root.join("progress.json"), 128)
            && let Ok([done, total]) = serde_json::from_slice::<[u64; 2]>(&bytes)
        {
            progress.total.store(total, Ordering::Relaxed);
            progress.done.store(done, Ordering::Relaxed);
            progress.phase.store(1, Ordering::Release);
        }
        if let Some(status) = child.0.try_wait()? {
            if !status.success() {
                return Err(WorkerFailure { code: "child_died".into(), message: format!("export worker exited {status}") }.into());
            }
            let report: WorkerReport = serde_json::from_slice(&read_bounded(&root.join("report.json"), REPORT_BYTES)?)?;
            report.result?;
            break;
        }
        thread::sleep(Duration::from_millis(30));
    }
    check_cancel(progress)?;
    let parent = staging.parent().context("staging output has no parent")?;
    let mut destination = tempfile::NamedTempFile::new_in(parent)?;
    let mut source = File::open(root.join("output"))?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        check_cancel(progress)?;
        let count = source.read(&mut buffer)?;
        if count == 0 { break; }
        destination.write_all(&buffer[..count])?;
    }
    destination.as_file().sync_all()?;
    check_cancel(progress)?;
    // This is an authorized staging path, never the user's destination. No-clobber
    // protects both an accidental reused grant and any preexisting file.
    destination.persist_noclobber(staging).map_err(|e| e.error)?;
    if progress.cancelled.load(Ordering::Acquire) {
        let _ = std::fs::remove_file(staging);
        bail!("export cancelled");
    }
    Ok(())
}

/// Called directly by the engine binary's fixed worker mode, before coordinator
/// startup. No protocol handles or native live output are initialized here.
pub fn run_worker(root: &Path) -> Result<()> {
    let result = (|| -> Result<()> {
        let input: WorkerInput = serde_json::from_slice(&read_bounded(&root.join("input.json"), crate::protocol::FRAME_BYTES)?)?;
        let assets = sources::PinnedAssets::read_transfer(&root.join("assets"))?;
        let context = sources::context(assets.clone(), Arc::new(AtomicBool::new(false)));
        context.run(|| {
            let bytes = read_bounded(&root.join("snapshot.json"), muz::snapshot::MAX_SNAPSHOT_BYTES)?;
            let snapshot = PlayableSnapshotV1::decode_checked(&bytes, muz::snapshot::MAX_SNAPSHOT_BYTES)?;
            drop(bytes);
            // Check every version through the installed immutable resolver, never
            // FileAssets or the current state of the original project directory.
            let session = snapshot.restore_checked().map_err(|error| WorkerFailure {
                code: "changed_asset".into(), message: format!("{error:#}"),
            })?;
            validate(&session, &input.spec)?;
            match input.spec {
                Spec::Midi { tracks } => render_midi(&session, &tracks, root),
                spec => render_wav(&session, &spec, root),
            }
        })
    })();
    let report = WorkerReport { result: result.map_err(|error| {
        if let Some(clipping) = error.downcast_ref::<WorkerFailure>() {
            return WorkerFailure { code: clipping.code.clone(), message: clipping.message.clone() };
        }
        let code = error.downcast_ref::<Failure>().map(|e| e.code.as_str()).unwrap_or("file_write_failed");
        WorkerFailure { code: code.into(), message: format!("{error:#}").chars().take(16000).collect() }
    }) };
    std::fs::write(root.join("report.json"), serde_json::to_vec(&report)?)?;
    Ok(())
}

fn render_midi(session: &muz::Session, tracks: &[String], root: &Path) -> Result<()> {
    std::fs::write(root.join("progress.json"), b"[0,1]")?;
    // Core emits performed notes (including sampler/SFZ trigger notes), controllers,
    // raw channel messages and source channels, plus conductor tempo and meter.
    let mut document = muz::smf::export(session)?;
    let mut selected = std::iter::once(true).chain(session.tracks.iter().filter_map(|track| {
        matches!(&track.source, TrackSource::Midi(_)).then(|| tracks.iter().any(|id| id == track.id.as_str()))
    }));
    document.tracks.retain(|_| selected.next().unwrap_or(false));
    muz::smf::write(&root.join("output"), &document)?;
    std::fs::write(root.join("progress.json"), b"[1,1]")?;
    Ok(())
}

fn render_wav(session: &muz::Session, spec: &Spec, root: &Path) -> Result<()> {
    let (rate, bits, start, duration, tracks) = match spec {
        Spec::MasterWav => (48000, 24, 0.0, full_duration(session)?, None),
        Spec::Wav { tracks, rate, bits, start, end } => (*rate, *bits, *start, end - start, Some(tracks)),
        Spec::Midi { .. } => unreachable!("MIDI dispatch handled separately"),
    };
    let mut engine = muz::audio::AudioEngine::new(session, muz::audio::AudioConfig {
        sample_rate: rate as f32, max_frames: BLOCK, offline: true,
    })?;
    if let Some(tracks) = tracks {
        // render_with's solo is group/prefix matching; exports require exact IDs.
        // Keep voices/sidechains alive and gate only their master-bound routes.
        engine.set_track_audibility(tracks, false)?;
    }
    let begin = (start * rate as f64).round() as u64 + engine.latency_samples() as u64;
    let frames = (duration * rate as f64).round() as u64;
    ensure!(frames > 0, "export interval contains no audio frames");
    let total = begin.checked_add(frames).context("export frame overflow")?;
    // RIFF's 32-bit length includes 36 header bytes. Never render an invalid file.
    ensure!(frames <= (u32::MAX as u64 - 36) / (2 * (bits as u64 / 8)), "WAV exceeds RIFF byte limit");
    let mut writer = hound::WavWriter::new(BufWriter::with_capacity(128 * 1024, File::create(root.join("output"))?),
        hound::WavSpec { channels: 2, sample_rate: rate, bits_per_sample: bits, sample_format: hound::SampleFormat::Int })?;
    let mut processed = 0u64;
    let mut last_progress = 0u64;
    let mut buffer = [0.0_f32; BLOCK * 2];
    let mut rng = 0x5ad9312_u64;
    let scale = (1u64 << (bits - 1)) as f64;
    std::fs::write(root.join("progress.json"), serde_json::to_vec(&[0, total])?)?;
    engine.set_running(true);
    while processed < total {
        muz::audio::clap::service_main_thread();
        let count = (total - processed).min(BLOCK as u64) as usize;
        engine.render_interleaved(&mut buffer[..count * 2], 2)?;
        let skip = begin.saturating_sub(processed).min(count as u64) as usize * 2;
        for &sample in &buffer[skip..count * 2] {
            ensure!(sample.is_finite(), "non-finite audio in export");
            if sample.abs() > 1.0 {
                return Err(WorkerFailure {
                    code: "export_clipping".into(),
                    message: "PCM export would clip; lower the master level and export again".into(),
                }.into());
            }
            let mut uniform = || {
                rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17;
                (rng >> 11) as f64 / (1u64 << 53) as f64
            };
            let dither = uniform() - uniform();
            writer.write_sample((sample as f64 * scale + dither).round().clamp(-scale, scale - 1.0) as i32)?;
        }
        processed += count as u64;
        if processed - last_progress >= rate as u64 || processed == total {
            std::fs::write(root.join("progress.json"), serde_json::to_vec(&[processed, total])?)?;
            last_progress = processed;
        }
    }
    writer.finalize()?;
    Ok(())
}
