import { createEngine } from "./engine.js";
const bytes = fetch(new URL("../public/muz.wasm", import.meta.url)).then(
  (r) => {
    if (!r.ok)
      throw new Error("Build the WASM engine with npm run prepare:engine");
    return r.arrayBuffer();
  },
);
let engine = bytes.then(createEngine);
// The first request may arrive after loading has failed; report that failure
// through the request instead of triggering a worker-restart loop.
void engine.catch(() => {});
self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ id: data.id, value: (await engine).call(data.message) });
  } catch (e: any) {
    if (e instanceof WebAssembly.RuntimeError) {
      engine = Promise.reject(new Error("Compiler engine failed. Restart the engine to recover."));
      void engine.catch(() => {});
    }
    self.postMessage({
      id: data.id,
      fatal: e instanceof WebAssembly.RuntimeError,
      error: e.diagnostic ?? { message: e.message },
    });
  }
};
