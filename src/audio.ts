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
  onPosition: (value: any) => void = () => {};
  onError: (value: any) => void = () => {};
  onPlaying: () => void = () => {};
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
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    node.connect(context.destination, 0);
    if (this.analysisEnabled) node.connect(analyser, 1);
    const silent = context.createGain();
    silent.gain.value = 0;
    analyser.connect(silent).connect(context.destination);
    node.port.onmessage = ({ data }) => {
      if (data.epoch !== this.epoch) return;
      this.beat = data.beat;
      if (data.type === "ended") {
        this.playing = false;
        this.onPlaying();
      }
      this.onPosition(data);
    };
    node.onprocessorerror = () =>
      this.onError({
        message:
          "Audio output stopped. Reload the page to recreate the audio worklet.",
      });
    this.context = context;
    this.node = node;
    this.analyser = analyser;
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
    this.node!.port.postMessage({ type: "playing", value: true });
    this.onPlaying();
  }
  async setAudition(muted: string[], solo: string[]) {
    if (!this.worker || !this.loaded) return;
    await this.call({ type: "audition", muted, solo });
  }
  selectAnalysis(id: string | null) {
    this.analysisSource = id;
    this.worker?.postMessage({ type: "analysis", id, enabled: this.analysisEnabled });
    this.node?.port.postMessage({ type: "analysis", id });
  }
  setAnalysisEnabled(enabled: boolean) {
    if (this.analysisEnabled === enabled) return;
    this.analysisEnabled = enabled;
    if (this.node && this.analyser) {
      if (enabled) this.node.connect(this.analyser, 1);
      else this.node.disconnect(this.analyser, 1);
    }
    this.selectAnalysis(this.analysisSource);
  }
  pause() {
    this.playing = false;
    this.node?.port.postMessage({ type: "playing", value: false });
    this.onPlaying();
  }
  async seek(beat: number) {
    this.epoch++;
    const status = await this.call({
      type: "seek", beat, range: this.loop, epoch: this.epoch,
    });
    this.beat = status.beat;
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
    const status = await this.call({ type: "panic", epoch: ++this.epoch });
    this.beat = status.beat;
    return status;
  }
  async shutdown() {
    this.dispose();
    this.node?.disconnect();
    this.analyser?.disconnect();
    await this.context?.close();
    this.context = undefined;
    this.node = undefined;
    this.analyser = undefined;
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
