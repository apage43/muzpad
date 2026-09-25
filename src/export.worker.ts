import { createEngine } from "./engine.js";
import { bounceWav } from "./export-audio.js";
self.onmessage = async ({ data }) => {
  try {
    const response = await fetch(
      new URL("../public/muz.wasm", import.meta.url),
    );
    if (!response.ok) throw new Error("Could not load the export engine");
    const engine = await createEngine(await response.arrayBuffer());
    let result;
    if (data.format === "midi") {
      const value = engine.call({
        command: "export_midi",
        snapshot: data.snapshot,
        tracks: data.tracks,
      });
      result = { bytes: new Uint8Array(value.bytes), clipped: 0 };
    } else {
      engine.call({ command: "assets", entries: data.assets });
      engine.call({
        command: "load",
        snapshot: data.snapshot,
        rate: data.rate,
      });
      result = bounceWav(engine, data, (progress: number) =>
        self.postMessage({ progress }),
      );
    }
    self.postMessage(result, { transfer: [result.bytes.buffer] });
  } catch (error: any) {
    self.postMessage({ error: error.message || "Export failed" });
  }
};
