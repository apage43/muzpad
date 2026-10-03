use muz::native::{ObservationFrame, ObservationTarget};
use parking_lot::{Condvar, Mutex};
use rustfft::{num_complex::Complex, FftPlanner};
use serde_json::{json, Value};
use std::sync::{atomic::{AtomicU64, Ordering}, Arc};

struct Pending { latest:Option<(Value,ObservationFrame)>, stopped:bool }
pub struct Analysis {
    input:Arc<(Mutex<Pending>,Condvar)>, output:Arc<Mutex<Option<Value>>>,
    dropped:Arc<AtomicU64>, thread:Option<std::thread::JoinHandle<()>>,
}
impl Analysis {
    pub fn new()->Self {
        let input=Arc::new((Mutex::new(Pending{latest:None,stopped:false}),Condvar::new()));
        let output=Arc::new(Mutex::new(None));
        let dropped=Arc::new(AtomicU64::new(0));
        let worker_input=input.clone();let worker_output=output.clone();let worker_dropped=dropped.clone();
        let thread=std::thread::spawn(move|| {
            let fft=FftPlanner::<f32>::new().plan_fft_forward(2048);
            let mut spectrum=vec![Complex::default();2048];
            let mut scratch=vec![Complex::default();fft.get_inplace_scratch_len()];
            loop {
                let (reference,frame)={
                    let (lock,wake)=&*worker_input;let mut pending=lock.lock();
                    while pending.latest.is_none()&&!pending.stopped{wake.wait(&mut pending);}
                    if pending.stopped{break;}
                    pending.latest.take().unwrap()
                };
                if frame.mono_samples.is_empty() || !frame.running {continue;}
                spectrum.fill(Complex::default());
                let count=frame.mono_samples.len().min(2048);
                for (i,&sample) in frame.mono_samples[..count].iter().enumerate() {
                    let window=0.5-0.5*(std::f32::consts::TAU*i as f32/(count.saturating_sub(1).max(1)) as f32).cos();
                    spectrum[i].re=sample*window;
                }
                fft.process_with_scratch(&mut spectrum,&mut scratch);
                let magnitudes:Vec<f32>=spectrum[..1024].iter().map(|v|v.norm()*4.0/count as f32).collect();
                let [peak,rms]=frame.master.unwrap_or([0.,0.]);
                let source=match frame.target {Some(ObservationTarget::Track(id))=>Some(id),_=>None};
                let meters:Vec<Value>=frame.tracks.iter().map(|m|json!({"track":m.id,"peak":m.peak,"rms":m.rms})).collect();
                let mut result=worker_output.lock();
                if result.is_some(){worker_dropped.fetch_add(1,Ordering::Relaxed);}
                *result=Some(json!({"ref":reference,"generation":frame.transport_generation.to_string(),"sequence":frame.sequence.to_string(),"source":source,
                    "sampleRate":frame.sample_rate,"captureSeconds":frame.sample_position as f64/frame.sample_rate as f64,
                    "waveform":&frame.mono_samples[..count],"spectrum":magnitudes,"meters":meters,"peak":peak,"rms":rms,
                    "dropped":frame.dropped.saturating_add(worker_dropped.load(Ordering::Relaxed)).to_string()}));
            }
        });
        Self{input,output,dropped,thread:Some(thread)}
    }
    pub fn submit(&self,reference:Value,frame:ObservationFrame) {
        let (lock,wake)=&*self.input;let mut pending=lock.lock();
        if pending.latest.replace((reference,frame)).is_some(){self.dropped.fetch_add(1,Ordering::Relaxed);}
        wake.notify_one();
    }
    pub fn poll(&self)->Option<Value>{self.output.lock().take()}
    pub fn clear(&self){self.input.0.lock().latest=None;self.output.lock().take();}
    pub fn shutdown(&mut self){
        {let (lock,wake)=&*self.input;let mut pending=lock.lock();pending.stopped=true;pending.latest=None;wake.notify_one();}
        if let Some(thread)=self.thread.take(){let _=thread.join();}
    }
}
impl Drop for Analysis{fn drop(&mut self){self.shutdown();}}
