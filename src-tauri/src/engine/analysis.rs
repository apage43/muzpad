use muz::native::{ObservationFrame, ObservationTarget};
use parking_lot::{Condvar, Mutex};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use serde_json::{json, Value};
use std::sync::Arc;

const WINDOW_SAMPLES: usize = 2048;
const SPECTRUM_BINS: usize = WINDOW_SAMPLES / 2 + 1;

// Everything in this module runs on coordinator/worker threads, never the audio
// callback. A single mutex owns both mailboxes and the invalidation barrier.
#[derive(PartialEq)]
struct Identity {
    reference: Value,
    revision: u64,
    generation: u64,
    capture_epoch: u64,
    target: Option<ObservationTarget>,
}
struct Work { reference: Value, frame: ObservationFrame, epoch: u64 }
#[derive(Default)]
struct Pending {
    latest: Option<Work>,
    output: Option<Value>,
    identity: Option<Identity>,
    last_sequence: Option<u64>,
    epoch: u64,
    dropped: u64,
    stopped: bool,
}
impl Pending {
    fn invalidate(&mut self) {
        self.epoch = self.epoch.checked_add(1).expect("Analysis invalidation epoch exhausted");
        self.latest = None;
        self.output = None;
        self.identity = None;
        self.last_sequence = None;
    }
    fn submit(&mut self, reference: Value, frame: ObservationFrame) {
        if self.stopped { return; }
        // A meter-only observation must not replace a pending detailed window.
        if frame.target.is_none() { return; }
        let same_identity = self.identity.as_ref().is_some_and(|identity|
            identity.reference == reference && identity.revision == frame.revision
                && identity.generation == frame.transport_generation
                && identity.capture_epoch == frame.capture_epoch && identity.target == frame.target
        );
        if !same_identity {
            self.invalidate();
            self.identity = Some(Identity {
                reference: reference.clone(), revision: frame.revision,
                generation: frame.transport_generation, capture_epoch: frame.capture_epoch,
                target: frame.target.clone(),
            });
        }
        if !valid_window(&frame) {
            // Incomplete/paused capture also retires a completed but unpolled FFT.
            self.invalidate();
            return;
        }
        if self.last_sequence.is_some_and(|last| frame.sequence <= last) { return; }
        self.last_sequence = Some(frame.sequence);
        let work = Work { reference, frame, epoch: self.epoch };
        if self.latest.replace(work).is_some() {
            self.dropped = self.dropped.saturating_add(1);
        }
    }
    fn publish(&mut self, epoch: u64, mut result: Value, capture_dropped: u64) {
        if self.stopped || epoch != self.epoch { return; }
        // A completed current-identity window remains useful when a newer input
        // is pending. Replace one output slot; rejecting on overlap would starve
        // publication whenever producer arrivals outpace the FFT worker.
        if self.output.is_some() { self.dropped = self.dropped.saturating_add(1); }
        result["dropped"] = json!(capture_dropped.saturating_add(self.dropped).to_string());
        self.output = Some(result);
    }
}
fn valid_window(frame: &ObservationFrame) -> bool {
    frame.running && frame.target.is_some()
        && frame.sample_count == WINDOW_SAMPLES
        && frame.mono_samples.len() == WINDOW_SAMPLES
        && frame.sample_position >= WINDOW_SAMPLES as u64
        && frame.sample_rate.is_finite() && frame.sample_rate > 0.
}
fn finite(value: f32) -> f32 { if value.is_finite() { value } else { 0. } }

struct Transform {
    fft: Arc<dyn Fft<f32>>,
    input: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    window: Vec<f32>,
    amplitude_scale: f32,
    waveform: Vec<f32>,
    magnitudes: Vec<f32>,
}
impl Transform {
    fn new() -> Self {
        let fft = FftPlanner::<f32>::new().plan_fft_forward(WINDOW_SAMPLES);
        // Periodic Hann has exact coherent gain 1/2. Precompute the actual sum
        // rather than assuming gain when changing the window implementation.
        let window: Vec<f32> = (0..WINDOW_SAMPLES).map(|i|
            0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / WINDOW_SAMPLES as f32).cos()
        ).collect();
        let amplitude_scale = 2. / window.iter().sum::<f32>();
        let scratch = vec![Complex::default(); fft.get_inplace_scratch_len()];
        Self { fft, input: vec![Complex::default(); WINDOW_SAMPLES], scratch,
            window, amplitude_scale, waveform: vec![0.; WINDOW_SAMPLES],
            magnitudes: vec![0.; SPECTRUM_BINS] }
    }
    fn compute(&mut self, samples: &[f32]) -> [f32; 2] {
        assert_eq!(samples.len(), WINDOW_SAMPLES);
        let mut peak = 0_f32;
        let mut squares = 0_f64;
        for (i, &sample) in samples.iter().enumerate() {
            let sample = finite(sample);
            peak = peak.max(sample.abs());
            squares += f64::from(sample) * f64::from(sample);
            self.waveform[i] = sample;
            self.input[i] = Complex::new(sample * self.window[i], 0.);
        }
        self.fft.process_with_scratch(&mut self.input, &mut self.scratch);
        for (k, value) in self.input[..SPECTRUM_BINS].iter().enumerate() {
            // Linear peak-amplitude dBFS convention: 1.0 = 0 dBFS. Interior
            // positive-frequency bins combine the conjugate pair; DC/Nyquist
            // are their own partners and therefore must not be doubled.
            let scale = if k == 0 || k == WINDOW_SAMPLES / 2 { self.amplitude_scale / 2. } else { self.amplitude_scale };
            self.magnitudes[k] = finite(value.re.hypot(value.im) * scale);
        }
        [peak, (squares / WINDOW_SAMPLES as f64).sqrt() as f32]
    }
    fn frame(&mut self, work: &Work) -> Value {
        let frame = &work.frame;
        // Scalars describe this same selected, unwindowed mono window, not the
        // independently scheduled stereo/master meter observation.
        let [peak, rms] = self.compute(&frame.mono_samples);
        let source = match &frame.target { Some(ObservationTarget::Track(id)) => Some(id), _ => None };
        // Core's tap is (L+R)/2, not stereo power. Anti-phase stereo cancels.
        // captureSeconds is sample-clock time, NOT calibrated wall-clock age.
        let mut result = json!({"ref":work.reference,"generation":frame.transport_generation.to_string(),
            "captureId":frame.capture_epoch.to_string(),"sequence":frame.sequence.to_string(),"source":source,
            "sampleRate":frame.sample_rate,"windowEndSample":frame.sample_position.to_string(),
            "sampleCount":frame.sample_count,"warmup":false,"window":"hann","smoothing":0,
            "captureSeconds":frame.sample_position as f64 / frame.sample_rate as f64,
            "waveform":self.waveform,"spectrum":self.magnitudes,
            "metersPresent":frame.meters_present,
            "meterWindowEndSample":frame.meter_sample_position.map(|p|p.to_string()),
            "peak":finite(peak),"rms":finite(rms)});
        result["meters"] = Value::Array(frame.tracks.iter().map(|m|
            json!({"track":m.id,"peak":finite(m.peak),"rms":finite(m.rms)})
        ).collect());
        result
    }
}

pub struct Analysis {
    input: Arc<(Mutex<Pending>, Condvar)>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Analysis {
    pub fn new() -> Self {
        let input = Arc::new((Mutex::new(Pending::default()), Condvar::new()));
        let worker_input = input.clone();
        let thread = std::thread::spawn(move || {
            let mut transform = Transform::new();
            loop {
                let work = {
                    let (lock, wake) = &*worker_input;
                    let mut pending = lock.lock();
                    while pending.latest.is_none() && !pending.stopped { wake.wait(&mut pending); }
                    if pending.stopped { break; }
                    pending.latest.take().unwrap()
                };
                let result = transform.frame(&work);
                worker_input.0.lock().publish(work.epoch, result, work.frame.dropped);
            }
        });
        Self { input, thread: Some(thread) }
    }
    pub fn submit(&self, reference: Value, frame: ObservationFrame) {
        let (lock, wake) = &*self.input;
        lock.lock().submit(reference, frame);
        wake.notify_one();
    }
    pub fn poll(&self) -> Option<Value> { self.input.0.lock().output.take() }
    pub fn clear(&self) { self.input.0.lock().invalidate(); }
    pub fn shutdown(&mut self) {
        {
            let (lock, wake) = &*self.input;
            let mut pending = lock.lock();
            pending.stopped = true;
            pending.invalidate();
            wake.notify_one();
        }
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}
impl Drop for Analysis { fn drop(&mut self) { self.shutdown(); } }

#[cfg(test)]
mod tests {
    use super::*;
    fn observation(sequence: u64) -> ObservationFrame {
        ObservationFrame { revision: 1, transport_generation: 2, capture_epoch: 3, sequence,
            sample_position: 2048, sample_count: 2048, sample_rate: 48000., running: true,
            master: None, tracks: vec![], mono_samples: vec![0.; WINDOW_SAMPLES],
            target: Some(ObservationTarget::Master), dropped: 0, meters_present: false,
            meter_sample_position: None }
    }
    fn close(actual: f32, expected: f32) { assert!((actual - expected).abs() < 0.0001, "{actual} != {expected}"); }
    #[test]
    fn calibrated_peak_amplitudes_at_all_supported_rates() {
        let mut transform = Transform::new();
        for rate in [44100., 48000., 96000.] {
            for bin in [1usize, 137, 1022] {
                let frequency = bin as f64 * rate / WINDOW_SAMPLES as f64;
                let samples: Vec<f32> = (0..WINDOW_SAMPLES).map(|i|
                    (0.75 * (std::f64::consts::TAU * frequency * i as f64 / rate).sin()) as f32
                ).collect();
                transform.compute(&samples);
                close(transform.magnitudes[bin], 0.75);
            }
            transform.compute(&vec![0.25; WINDOW_SAMPLES]);
            close(transform.magnitudes[0], 0.25);
            let nyquist: Vec<f32> = (0..WINDOW_SAMPLES).map(|i| if i % 2 == 0 { 0.5 } else { -0.5 }).collect();
            transform.compute(&nyquist);
            close(transform.magnitudes[WINDOW_SAMPLES / 2], 0.5);
            transform.compute(&vec![0.; WINDOW_SAMPLES]);
            assert!(transform.magnitudes.iter().all(|&v| v == 0.));
        }
    }
    #[test]
    fn reuses_plan_and_buffers_and_sanitizes_nonfinite_data() {
        let mut transform = Transform::new();
        let pointers = (transform.input.as_ptr(), transform.scratch.as_ptr(), transform.window.as_ptr(),
            transform.waveform.as_ptr(), transform.magnitudes.as_ptr());
        let mut samples = vec![0.; WINDOW_SAMPLES];
        samples[0] = f32::NAN; samples[1] = f32::INFINITY; samples[2] = f32::NEG_INFINITY;
        for _ in 0..3 { transform.compute(&samples); }
        assert!(transform.waveform.iter().all(|&v| v == 0.));
        assert!(transform.magnitudes.iter().all(|&v| v == 0.));
        assert_eq!(pointers, (transform.input.as_ptr(), transform.scratch.as_ptr(), transform.window.as_ptr(),
            transform.waveform.as_ptr(), transform.magnitudes.as_ptr()));
    }
    #[test]
    fn incomplete_capture_never_becomes_zero_padded_fft() {
        let mut frame = observation(1);
        assert!(valid_window(&frame));
        frame.sample_count = 1024;
        assert!(!valid_window(&frame));
        frame.sample_count = 2048; frame.mono_samples.pop();
        assert!(!valid_window(&frame));
        frame.mono_samples.push(0.); frame.sample_rate = f32::NAN;
        assert!(!valid_window(&frame));
        frame.sample_rate = 48000.; frame.sample_position = 2047;
        assert!(!valid_window(&frame));
    }
    #[test]
    fn stalled_worker_retains_only_latest_and_clear_retires_inflight() {
        let mut pending = Pending::default();
        pending.submit(json!({"revision":"accepted"}), observation(1));
        let old = pending.latest.take().unwrap();
        for sequence in 2..=100 { pending.submit(json!({"revision":"accepted"}), observation(sequence)); }
        assert_eq!(pending.latest.as_ref().unwrap().frame.sequence, 100);
        pending.publish(old.epoch, json!({"sequence":"1"}), 0);
        assert_eq!(pending.output.as_ref().unwrap()["sequence"], "1");
        let latest = pending.latest.take().unwrap();
        pending.publish(latest.epoch, json!({"sequence":"100"}), 0);
        assert_eq!(pending.output.as_ref().unwrap()["sequence"], "100");
        assert_eq!(pending.dropped, 99);
        pending.invalidate();
        pending.publish(latest.epoch, json!({"sequence":"100"}), 0);
        assert!(pending.output.is_none());
    }
    #[test]
    fn sustained_input_overlap_publishes_completed_windows_without_catchup_queue() {
        let mut pending = Pending::default();
        let reference = json!({"revision":"accepted"});
        pending.submit(reference.clone(), observation(1));
        for sequence in 1..100 {
            let executing = pending.latest.take().unwrap();
            assert_eq!(executing.frame.sequence, sequence);
            pending.submit(reference.clone(), observation(sequence + 1));
            pending.publish(executing.epoch, json!({"sequence":sequence.to_string()}), 0);
            assert_eq!(pending.output.take().unwrap()["sequence"], sequence.to_string());
            assert_eq!(pending.latest.as_ref().unwrap().frame.sequence, sequence + 1);
        }
        // A stalled output consumer still retains just the newest completion.
        let executing = pending.latest.take().unwrap();
        pending.publish(executing.epoch, json!({"sequence":"100"}), 0);
        pending.submit(reference, observation(101));
        let executing = pending.latest.take().unwrap();
        pending.publish(executing.epoch, json!({"sequence":"101"}), 0);
        assert_eq!(pending.output.take().unwrap()["sequence"], "101");
        assert!(pending.output.is_none());
    }
    #[test]
    fn identity_changes_invalidate_output_and_meter_only_does_not_replace_detail() {
        let mut pending = Pending::default();
        let reference = json!({"project":"p","epoch":"e","engineEpoch":"n","sourceVersion":7,"revision":"r"});
        pending.submit(reference.clone(), observation(1));
        let work = pending.latest.take().unwrap();
        pending.publish(work.epoch, json!({"sequence":"1"}), 0);
        for change in 0..4 {
            let mut next = observation(2 + change);
            match change { 0 => next.transport_generation += 1, 1 => next.capture_epoch += 1,
                2 => next.revision += 1, _ => next.target = Some(ObservationTarget::Track("t".into())) }
            pending.submit(reference.clone(), next);
            assert!(pending.output.is_none());
            assert!(pending.latest.is_some());
        }
        let mut meter = observation(100); meter.target = None; meter.mono_samples.clear(); meter.sample_count = 0;
        pending.submit(reference, meter);
        assert_eq!(pending.latest.as_ref().unwrap().frame.sequence, 5);
    }
    #[test]
    fn exact_decimal_window_identity_is_not_coerced_to_float() {
        let mut frame = observation(u64::MAX);
        frame.sample_position = u64::MAX; frame.capture_epoch = u64::MAX; frame.transport_generation = u64::MAX;
        let work = Work { reference: json!({"revision":"18446744073709551615"}), frame, epoch: 0 };
        let value = Transform::new().frame(&work);
        for key in ["windowEndSample", "captureId", "generation", "sequence"] {
            assert_eq!(value[key], "18446744073709551615");
        }
        assert_eq!(value["sampleCount"], 2048);
        assert_eq!(value["spectrum"].as_array().unwrap().len(), 1025);
        assert_eq!(value["metersPresent"], false);
    }
    #[test]
    fn detail_scalars_describe_selected_window_not_independent_master_meters() {
        let mut frame = observation(1);
        frame.target = Some(ObservationTarget::Track("silent".into()));
        frame.master = Some([0.75, 0.5]);
        frame.meters_present = true;
        frame.meter_sample_position = Some(1024);
        let mut transform = Transform::new();
        let mut work = Work { reference: json!({"revision":"1"}), frame, epoch: 0 };
        let silent = transform.frame(&work);
        assert_eq!(silent["peak"], 0.); assert_eq!(silent["rms"], 0.);
        assert_eq!(silent["source"], "silent");
        assert_eq!(silent["metersPresent"], true);
        assert_eq!(silent["meterWindowEndSample"], "1024");
        work.frame.mono_samples.fill(0.25);
        work.frame.master = None; work.frame.meters_present = false;
        let selected = transform.frame(&work);
        close(selected["peak"].as_f64().unwrap() as f32, 0.25);
        close(selected["rms"].as_f64().unwrap() as f32, 0.25);
        assert_eq!(selected["metersPresent"], false);
    }
}
