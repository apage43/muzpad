export class AudioPlayer {
  context?: AudioContext;
  analyser?: AnalyserNode;
  node?: AudioWorkletNode;
  worker?: Worker;
  pending?: Worker;
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
  async accept(snapshot: any, isCurrent: () => boolean) {
    await this.init();
    const worker = new Worker(new URL("./render.worker.ts", import.meta.url), {
      type: "module",
    });
    this.pending?.terminate();
    this.pending = worker;
    const status = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("Audio preparation exceeded 30 seconds"));
      }, 30000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message));
      };
      worker.onmessage = ({ data }) => {
        if (data.type === "ready") {
          clearTimeout(timer);
          resolve(data.status);
        }
        if (data.type === "error") {
          clearTimeout(timer);
          worker.terminate();
          reject(
            Object.assign(new Error(data.error.message), {
              diagnostic: data.error,
            }),
          );
        }
      };
      worker.postMessage({
        type: "load",
        snapshot,
        rate: this.context!.sampleRate,
      });
    });
    if (!isCurrent()) {
      worker.terminate();
      return null;
    }
    this.worker?.terminate();
    if (this.loop && this.loop[1] > status.endBeat) this.loop = null;
    this.worker = worker;
    this.pending = undefined;
    worker.onmessage = ({ data }) => {
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
      this.pause();
      this.onError({ message: event.message });
    };
    const channel = new MessageChannel();
    this.node!.port.postMessage({ type: "connect", port: channel.port1 }, [
      channel.port1,
    ]);
    worker.postMessage({ type: "connect", port: channel.port2 }, [
      channel.port2,
    ]);
    this.selectAnalysis(this.analysisSource);
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
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    this.requests.clear();
    this.worker = this.create();
  }
}
