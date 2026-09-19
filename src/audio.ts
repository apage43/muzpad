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
    node.connect(analyser, 1);
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
        this.worker?.postMessage({ type: "discard", request: message.request });
        reject(
          new Error(
            message.type === "apply"
              ? "Audio apply response exceeded 30 seconds; reload before assuming which revision is active"
              : "Audio preparation exceeded 30 seconds; the accepted revision is retained",
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
      this.seek(Math.min(this.beat, Math.max(0, status.endBeat - 0.001)));
    return status;
  }
  async play() {
    if (!this.worker) return;
    await this.context!.resume();
    this.playing = true;
    this.node!.port.postMessage({ type: "playing", value: true });
    this.onPlaying();
  }
  selectAnalysis(id: string | null) {
    this.analysisSource = id;
    this.worker?.postMessage({ type: "analysis", id });
    this.node?.port.postMessage({ type: "analysis", id });
  }
  pause() {
    this.playing = false;
    this.node?.port.postMessage({ type: "playing", value: false });
    this.onPlaying();
  }
  seek(beat: number) {
    this.beat = beat;
    this.epoch++;
    this.worker?.postMessage({
      type: "seek",
      beat,
      range: this.loop,
      epoch: this.epoch,
    });
  }
  stop() {
    this.pause();
    this.seek(this.loop?.[0] ?? 0);
  }
  setLoop(range: [number, number] | null) {
    this.loop = range;
    this.seek(range?.[0] ?? this.beat);
  }
}

export class Compiler {
  worker = this.create();
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
    worker.onerror = (event) => this.reset(event.message);
    return worker;
  }
  call(message: any): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.reset(
            "Compilation exceeded 30 seconds. Simplify the source and try again.",
          ),
        30000,
      );
      this.requests.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, message });
    });
  }
  reset(reason = "Cancelled") {
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
}
