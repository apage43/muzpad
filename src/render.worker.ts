import { createEngine } from "./engine.js";
let engine: Awaited<ReturnType<typeof createEngine>>;
let port: MessagePort | undefined;
let epoch = 0,
  credits = 0,
  scheduled = false,
  done = false;
const pool: ArrayBuffer[] = [];
let analysis: string | null = null;
function pump() {
  if (scheduled || !credits || done || !port) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    if (!credits || done || !port) return;
    try {
      const started = performance.now();
      const meta = engine.call({ command: "render", frames: 1024, analysis });
      const audio = new Float32Array(pool.pop() ?? new ArrayBuffer(16384));
      engine.audio(1024, audio.subarray(0, 2048));
      engine.audio(1024, audio.subarray(2048), true);
      port.postMessage({ type: "audio", epoch, audio, meta, analysis }, [
        audio.buffer,
      ]);
      credits--;
      done = meta.status.done;
      self.postMessage({ type: "cost", ms: performance.now() - started });
      pump();
    } catch (e: any) {
      done = true;
      self.postMessage({
        type: "error",
        error: e.diagnostic ?? { message: e.message },
      });
    }
  }, 0);
}
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      engine = await createEngine(
        await (
          await fetch(new URL("../public/muz.wasm", import.meta.url))
        ).arrayBuffer(),
      );
      const status = engine.call({
        command: "load",
        snapshot: data.snapshot,
        rate: data.rate,
      });
      self.postMessage({ type: "ready", status });
    } else if (data.type === "analysis") {
      analysis = data.id;
    } else if (data.type === "connect") {
      port = data.port;
      port!.onmessage = ({ data }) => {
        if (data.buffer && pool.length < 32) pool.push(data.buffer);
        if (data.type === "credit" && data.epoch === epoch) {
          credits++;
          pump();
        }
      };
    } else if (data.type === "seek") {
      epoch = data.epoch;
      engine.call({ command: "loop", range: data.range });
      engine.call({ command: "seek", beat: data.beat });
      // Apply loop after seeking so an out-of-range seek starts at the loop's beginning.
      const status = engine.call({ command: "loop", range: data.range });
      credits = 24;
      done = false;
      port!.postMessage({ type: "reset", epoch, status });
      self.postMessage({ type: "seeked", epoch, status });
      pump();
    }
  } catch (e: any) {
    self.postMessage({
      type: "error",
      error: e.diagnostic ?? { message: e.message },
    });
  }
};
