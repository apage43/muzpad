const ANALYSIS_SAMPLES = 2048;
const BLACKMAN_COHERENT_GAIN = 0.42;

export interface WebAnalysis {
  waveform: number[];
  spectrum: number[];
  peak: number;
  rms: number;
  sampleRate: number;
  sampleCount: number;
  windowEndSample: null;
  captureSeconds: number;
  captureId: string;
  sequence: string;
  warmup: false;
  window: "blackman";
  smoothing: 0;
}

export class AudioPlayer {
  context?: AudioContext;
  analyser?: AnalyserNode;
  node?: AudioWorkletNode;
  worker?: Worker;
  nextRequest = 0;
  revision = 0;
  private loaded = false;
  private acceptance = 0;
  committing = false;
  private requests = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  playing = false;
  beat = 0;
  epoch = 0;
  loop: [number, number] | null = null;
  analysisSource: string | null = null;
  private analysisEnabled = false;
  private metersEnabled = false;
  private metersHz = 0;
  private silent?: GainNode;
  private analysisCapture = 0n;
  private analysisSequence = 0n;
  private analysisReady = false;
  private analysisPendingTransport = false;
  private analysisGeneration?: string;
  private analysisWaveform = new Float32Array(ANALYSIS_SAMPLES);
  private analysisFrequency = new Float32Array(ANALYSIS_SAMPLES / 2);
  onPosition: (value: any) => void = () => {};
  onError: (value: any) => void = () => {};
  onPlaying: () => void = () => {};
  onAnalysisInvalidated: (captureId: string) => void = () => {};
  async init() {
    if (this.context) return;
    const context = new AudioContext({
      sampleRate: 48000,
      latencyHint: "playback",
    });
    await context.audioWorklet.addModule(
      new URL("player-worklet.js", document.baseURI),
    );
    const node = new AudioWorkletNode(context, "muz-player", {
      numberOfInputs: 0,
      numberOfOutputs: 2,
      outputChannelCount: [2, 2],
    });
    node.connect(context.destination, 0);
    const silent = context.createGain();
    silent.gain.value = 0;
    node.port.onmessage = ({ data }) => this.receivePosition(data);
    node.onprocessorerror = () =>
      this.onError({
        message:
          "Audio output stopped. Reload the page to recreate the audio worklet.",
      });
    this.context = context;
    this.node = node;
    this.silent = silent;
    this.resetAnalysis();
    node.port.postMessage({ type: "meters", enabled: this.metersEnabled });
  }
  private createWorker() {
    const worker = new Worker(new URL("./render.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker) return;
      if (data.type === "fatal") {
        this.dispose();
        this.onError(data.error);
        return;
      }
      const request = this.requests.get(data.id);
      if (request) {
        clearTimeout(request.timer);
        this.requests.delete(data.id);
        if (data.error)
          request.reject(
            Object.assign(new Error(data.error.message), {
              diagnostic: data.error,
            }),
          );
        else request.resolve(data.value);
        return;
      }
      if (data.type === "error") {
        this.pause();
        this.onError(data.error);
      }
      if (data.type === "seeked" && data.epoch === this.epoch) {
        this.beat = data.status.beat;
        this.onPosition({ ...data.status, meters: [] });
      }
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      this.dispose();
      this.onError({
        message: `Rendering worker failed; playback continuity was lost. ${event.message}`,
      });
    };
    const channel = new MessageChannel();
    this.node!.port.postMessage({ type: "connect", port: channel.port1 }, [
      channel.port1,
    ]);
    worker.postMessage({ type: "connect", port: channel.port2 }, [
      channel.port2,
    ]);
    this.worker = worker;
    this.selectAnalysis(this.analysisSource);
    worker.postMessage({ type: "meters", enabled: this.metersEnabled, hz: this.metersHz });
  }
  private call(message: any): Promise<any> {
    const id = ++this.nextRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        if (message.type === "apply") {
          this.dispose();
          this.onError({
            code: "child_died",
            message: "Audio application did not acknowledge its outcome. Restart the engine before continuing.",
          });
        }
        if (message.type === "prepare" || message.type === "apply")
          this.worker?.postMessage({
            type: "discard",
            request: message.request,
          });
        reject(
          new Error(
            message.type === "apply"
              ? "Audio apply response exceeded 30 seconds; reload before assuming which revision is active"
              : message.type === "prepare"
                ? "Audio preparation exceeded 30 seconds; the accepted revision is retained"
                : "Audio control response exceeded 30 seconds",
          ),
        );
      }, 30000);
      this.requests.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ ...message, id });
    });
  }
  cancelPending() {
    this.acceptance++;
    this.worker?.postMessage({ type: "discard", request: this.acceptance - 1 });
  }
  dispose() {
    this.cancelPending();
    this.pause();
    this.worker?.terminate();
    this.worker = undefined;
    this.revision = 0;
    this.loaded = false;
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Cancelled"));
    }
    this.requests.clear();
  }
  async accept(
    snapshot: any,
    isCurrent: () => boolean,
    assets: any[] = [],
    onCommit?: () => void,
    authorize?: () => Promise<void>,
  ) {
    await this.init();
    if (!isCurrent()) return null;
    const initial = !this.loaded;
    if (!this.worker) this.createWorker();
    const request = ++this.acceptance;
    await this.call({
      type: "prepare",
      request,
      snapshot,
      assets,
      rate: this.context!.sampleRate,
      base_revision: this.revision,
    });
    try {
      if (authorize) await authorize();
    } catch (error) {
      this.worker?.postMessage({ type: "discard", request });
      throw error;
    }
    if (!isCurrent() || request !== this.acceptance) {
      this.worker?.postMessage({ type: "discard", request });
      return null;
    }
    this.committing = true;
    onCommit?.();
    let status;
    try {
      status = await this.call({ type: "apply", request });
    } finally {
      this.committing = false;
    }
    this.revision = status.revision;
    this.loaded = true;
    this.resetAnalysis();
    if (this.loop && this.loop[1] > status.endBeat) {
      this.loop = null;
      this.worker?.postMessage({ type: "loop", range: null });
    }
    if (initial)
      await this.seek(Math.min(this.beat, Math.max(0, status.endBeat - 0.001)));
    return status;
  }
  async play() {
    if (!this.worker) return;
    await this.context!.resume();
    this.playing = true;
    this.resetAnalysis();
    this.node!.port.postMessage({ type: "playing", value: true });
    this.onPlaying();
  }
  async setAudition(muted: string[], solo: string[]) {
    if (!this.worker || !this.loaded) return;
    await this.call({ type: "audition", muted, solo });
  }
  private receivePosition(data: unknown) {
    if (!data || typeof data !== "object" || !("epoch" in data) ||
        data.epoch !== this.epoch || !("type" in data)) return;
    if (data.type === "analysisReady") {
      if (!("captureId" in data) || data.captureId !== this.analysisCapture.toString() ||
          !("source" in data) || data.source !== this.analysisSource ||
          !("revision" in data) || data.revision !== this.revision || !("ready" in data)) return;
      const generationMatches = "generation" in data && typeof data.generation === "number" &&
        Number.isFinite(data.generation) && String(data.generation) === this.analysisGeneration;
      const wasReady = this.analysisReady;
      this.analysisReady = data.ready === true && generationMatches;
      if (wasReady && !this.analysisReady) this.onAnalysisInvalidated(this.analysisCapture.toString());
      return;
    }
    const generation = String(("generation" in data ? data.generation : undefined) ?? this.epoch);
    if (generation !== this.analysisGeneration) {
      this.analysisGeneration = generation;
      this.resetAnalysis();
    }
    if ("beat" in data && typeof data.beat === "number") this.beat = data.beat;
    if (data.type === "ended") {
      this.playing = false;
      this.resetAnalysis();
      this.onPlaying();
    }
    this.onPosition(data);
  }
  selectAnalysis(id: string | null) {
    const changed = this.analysisSource !== id;
    this.analysisSource = id;
    this.worker?.postMessage({ type: "analysis", id, enabled: this.analysisEnabled });
    if (changed) this.resetAnalysis();
    else this.node?.port.postMessage({
      type: "analysis", id, enabled: this.analysisEnabled, captureId: this.analysisCapture.toString(),
    });
  }
  setAnalysisEnabled(enabled: boolean) {
    if (this.analysisEnabled === enabled) return;
    this.analysisEnabled = enabled;
    this.resetAnalysis();
    this.selectAnalysis(this.analysisSource);
  }
  setMetersEnabled(enabled: boolean, hz: number) {
    if (!Number.isInteger(hz) || hz < 0 || hz > 20 || (enabled && hz === 0))
      throw new RangeError("Meter cadence must be an integer from 1 to 20 Hz, or zero when disabled");
    if (this.metersEnabled === enabled && this.metersHz === hz) return;
    this.metersEnabled = enabled;
    this.metersHz = hz;
    this.worker?.postMessage({ type: "meters", enabled, hz });
    this.node?.port.postMessage({ type: "meters", enabled });
  }
  private resetAnalysis() {
    this.analysisCapture++;
    this.analysisReady = false;
    this.onAnalysisInvalidated(this.analysisCapture.toString());
    this.node?.port.postMessage({
      type: "analysis", id: this.analysisSource, enabled: this.analysisEnabled,
      captureId: this.analysisCapture.toString(),
    });
    if (this.analyser) {
      this.node?.disconnect(this.analyser, 1);
      this.analyser.disconnect();
      this.analyser = undefined;
    }
    this.silent?.disconnect();
    if (!this.context || !this.node || !this.silent || !this.analysisEnabled || !this.playing) return;
    const analyser = this.context.createAnalyser();
    analyser.fftSize = ANALYSIS_SAMPLES;
    analyser.smoothingTimeConstant = 0;
    analyser.channelCount = 1;
    analyser.channelCountMode = "explicit";
    analyser.channelInterpretation = "speakers";
    this.node.connect(analyser, 1);
    analyser.connect(this.silent).connect(this.context.destination);
    this.analyser = analyser;
    // Replacing the analyser discards its old-source history. Readiness comes
    // from 2048 contiguous matching monitor samples confirmed by the worklet,
    // not elapsed graph time while rejected old-source packets drain.
  }
  readAnalysis(): WebAnalysis | null {
    const context = this.context, analyser = this.analyser;
    if (this.committing || this.analysisPendingTransport || !this.analysisReady ||
        !this.analysisEnabled || !this.playing || !context || !analyser || context.state !== "running") return null;
    analyser.getFloatTimeDomainData(this.analysisWaveform);
    analyser.getFloatFrequencyData(this.analysisFrequency);
    // The Web Audio analyser uses a periodic Blackman window, not native Hann.
    // With analyser smoothing disabled, its 1/N Fourier normalization requires
    // coherent-gain correction and interior conjugate-pair doubling. It omits
    // Nyquist (1024 bins for N2048). Display smoothing belongs to the renderer.
    // Mono speaker downmix is (L+R)/2: anti-phase stereo cancels in both backends.
    let peak = 0, squares = 0;
    const waveform = Array.from(this.analysisWaveform, sample => {
      const finite = Number.isFinite(sample) ? sample : 0;
      peak = Math.max(peak, Math.abs(finite)); squares += finite * finite;
      return finite;
    });
    const spectrum = Array.from(this.analysisFrequency, (db, bin) => {
      const amplitude = 10 ** (db / 20) * (bin === 0 ? 1 : 2) / BLACKMAN_COHERENT_GAIN;
      return Number.isFinite(amplitude) ? amplitude : 0;
    });
    return {
      waveform, spectrum, peak, rms: Math.sqrt(squares / ANALYSIS_SAMPLES),
      sampleRate: context.sampleRate, sampleCount: ANALYSIS_SAMPLES,
      windowEndSample: null, captureSeconds: context.currentTime,
      captureId: this.analysisCapture.toString(), sequence: (++this.analysisSequence).toString(),
      warmup: false, window: "blackman", smoothing: 0,
    };
  }
  pause() {
    this.playing = false;
    this.resetAnalysis();
    this.node?.port.postMessage({ type: "playing", value: false });
    this.onPlaying();
  }
  async seek(beat: number) {
    this.epoch++;
    this.analysisReady = false;
    this.analysisPendingTransport = true;
    let status;
    try {
      status = await this.call({
        type: "seek", beat, range: this.loop, epoch: this.epoch,
      });
    } finally {
      this.analysisPendingTransport = false;
    }
    this.beat = status.beat;
    this.analysisGeneration = String(status.generation ?? this.epoch);
    this.resetAnalysis();
    return status;
  }
  async stop() {
    this.pause();
    return this.seek(this.loop?.[0] ?? 0);
  }
  async setLoop(range: [number, number] | null) {
    const previous = this.loop;
    this.loop = range;
    try {
      return await this.seek(range?.[0] ?? this.beat);
    } catch (error) {
      this.loop = previous;
      throw error;
    }
  }
  async panic() {
    this.analysisReady = false;
    this.analysisPendingTransport = true;
    let status;
    try {
      status = await this.call({ type: "panic", epoch: ++this.epoch });
    } finally {
      this.analysisPendingTransport = false;
    }
    this.beat = status.beat;
    this.analysisGeneration = String(status.generation ?? this.epoch);
    this.resetAnalysis();
    return status;
  }
  async shutdown() {
    this.dispose();
    this.node?.disconnect();
    this.analyser?.disconnect();
    this.silent?.disconnect();
    await this.context?.close();
    this.context = undefined;
    this.node = undefined;
    this.analyser = undefined;
    this.silent = undefined;
  }
}

export class Compiler {
  worker = this.create();
  private failure?: string;
  onFailure: (message: string) => void = () => {};
  next = 0;
  requests = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: any) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  create() {
    const worker = new Worker(
      new URL("./compiler.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker) return;
      if (data.fatal) {
        this.failure = data.error.message;
        this.worker.terminate();
        this.cancel(this.failure);
        this.onFailure(this.failure!);
        return;
      }
      const pending = this.requests.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.requests.delete(data.id);
      if (data.error)
        pending.reject(
          Object.assign(new Error(data.error.message), {
            diagnostic: data.error,
          }),
        );
      else pending.resolve(data.value);
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      this.failure = event.message || "Compiler worker failed";
      this.worker.terminate();
      this.cancel(this.failure);
      this.onFailure(this.failure);
    };
    return worker;
  }
  call(message: any): Promise<any> {
    if (this.failure) return Promise.reject(new Error(this.failure));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.failure = "Compilation exceeded 30 seconds. Restart the engine before rebuilding.";
          this.worker.terminate();
          this.cancel(this.failure);
          this.onFailure(this.failure);
        },
        30000,
      );
      this.requests.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, message });
    });
  }
  reset(reason = "Cancelled") {
    this.failure = undefined;
    this.worker.terminate();
    this.cancel(reason);
    this.worker = this.create();
  }
  cancel(reason = "Cancelled") {
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    this.requests.clear();
  }
  dispose() {
    this.failure = "Compiler disposed";
    this.worker.terminate();
    this.cancel(this.failure);
  }
}
