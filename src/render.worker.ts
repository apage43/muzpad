import { createEngine } from "./engine.js";
let engine: Awaited<ReturnType<typeof createEngine>>;
const ready = fetch(new URL("../public/muz.wasm", import.meta.url))
  .then((r) => {
    if (!r.ok) throw new Error("Build the WASM engine first");
    return r.arrayBuffer();
  })
  .then(createEngine)
  .then((value) => (engine = value));
void ready.catch(() => {});
let port: MessagePort | undefined;
let epoch = 0,
  credits = 0,
  scheduled = false,
  done = false;
const pool: ArrayBuffer[] = [];
let analysis: string | null = null;
let analysisEnabled = false;
let metersEnabled = false;
let meterHz = 20;
let nextMeters = 0;
let initialized = false;
let pending: any;
function emitAudio(fadeOut = false) {
  const now = performance.now();
  const meterDue = metersEnabled && now >= nextMeters;
  const meta = engine.call({
    command: "render",
    frames: 1024,
    analysis,
    analysis_enabled: analysisEnabled,
    meters_enabled: meterDue,
    fade_out: fadeOut,
  });
  if (!metersEnabled) meta.meters = [];
  else if (!meterDue) delete meta.meters;
  if (meterDue) {
    const period = 1000 / meterHz;
    nextMeters += (Math.floor((now - nextMeters) / period) + 1) * period;
  }
  const audio = new Float32Array(pool.pop() ?? new ArrayBuffer(16384));
  engine.audio(1024, audio.subarray(0, 2048));
  engine.audio(1024, audio.subarray(2048), true);
  port!.postMessage(
    {
      type: "audio",
      epoch,
      revision: meta.status.revision,
      audio,
      meta,
      analysis,
    },
    [audio.buffer],
  );
  credits = Math.max(0, credits - 1);
  done = meta.status.done;
}
function pump() {
  if (scheduled || !credits || done || !port || !initialized) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    if (!credits || done || !port || !initialized) return;
    try {
      const started = performance.now();
      emitAudio();
      self.postMessage({ type: "cost", ms: performance.now() - started });
      pump();
    } catch (e: any) {
      done = true;
      const error = e.diagnostic ?? { message: e.message };
      if (e instanceof WebAssembly.RuntimeError)
        self.postMessage({
          type: "fatal",
          error: {
            message: `Rendering engine failed; playback continuity was lost. ${error.message}`,
          },
        });
      else self.postMessage({ type: "error", error });
    }
  }, 0);
}
let commands = Promise.resolve();
self.onmessage = ({ data }) => {
  if (data.type === "connect") {
    port = data.port;
    port!.onmessage = ({ data }) => {
      if (data.buffer && pool.length < 32) pool.push(data.buffer);
      if (data.type === "credit" && data.epoch === epoch) {
        credits = Math.min(24, credits + 1);
        pump();
      }
    };
    return;
  }
  commands = commands.then(async () => {
    try {
      await ready;
      let value: any;
      if (data.type === "prepare") {
        pending = undefined;
        engine.call({ command: "discard" });
        engine.call({ command: "assets", entries: data.assets ?? [] });
        pending = engine.call({
          command: "prepare",
          snapshot: data.snapshot,
          rate: data.rate,
          request: data.request,
          base_revision: data.base_revision,
        });
        value = pending;
      } else if (data.type === "apply") {
        if (!pending || pending.request !== data.request)
          throw new Error("Stale prepared revision");
        if (
          initialized &&
          engine.call({ command: "status" }).generation !== pending.generation
        )
          throw new Error(
            "Transport changed during preparation; rebuild again",
          );
        const queuedFade = pending.needs_fade && initialized && !credits;
        if (pending.needs_fade && initialized && port && credits)
          emitAudio(true);
        value = engine.call({ command: "apply", request: data.request });
        pending = undefined;
        initialized = true;
        done = false;
        port?.postMessage({
          type: "revision",
          epoch,
          revision: value.revision,
          queuedFade,
        });
        pump();
      } else if (data.type === "discard") {
        const matches =
          data.request === undefined || pending?.request === data.request;
        if (matches) {
          engine.call({ command: "discard" });
          pending = undefined;
        }
        value = { discarded: matches };
      } else if (data.type === "audition" && initialized) {
        value = engine.call({
          command: "audition",
          muted: data.muted,
          solo: data.solo,
        });
      } else if (data.type === "meters") {
        metersEnabled = data.enabled === true;
        if (Number.isFinite(data.hz) && data.hz > 0 && data.hz <= 20) meterHz = data.hz;
        nextMeters = performance.now();
      } else if (data.type === "analysis") {
        analysis = data.id;
        analysisEnabled = data.enabled === true;
      } else if (data.type === "loop" && initialized) {
        value = engine.call({ command: "loop", range: data.range });
      } else if (data.type === "panic" && initialized) {
        epoch = data.epoch;
        value = engine.call({ command: "panic" });
        credits = 24;
        done = false;
        port!.postMessage({ type: "reset", epoch, status: value });
        pump();
      } else if (data.type === "seek" && initialized) {
        epoch = data.epoch;
        engine.call({ command: "loop", range: data.range });
        engine.call({ command: "seek", beat: data.beat });
        // Apply loop after seeking so an out-of-range seek starts at the loop's beginning.
        const status = engine.call({ command: "loop", range: data.range });
        credits = 24;
        done = false;
        port!.postMessage({ type: "reset", epoch, status });
        self.postMessage({ type: "seeked", epoch, status });
        value = status;
        pump();
      }
      if (data.id !== undefined) self.postMessage({ id: data.id, value });
    } catch (e: any) {
      const error = e.diagnostic ?? { message: e.message };
      if (e instanceof WebAssembly.RuntimeError)
        self.postMessage({
          type: "fatal",
          error: {
            message: `Rendering engine failed; playback continuity was lost. ${error.message}`,
          },
        });
      else if (data.id !== undefined) self.postMessage({ id: data.id, error });
      else self.postMessage({ type: "error", error });
    }
  });
};
