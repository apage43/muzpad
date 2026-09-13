import { readFile, readdir } from "node:fs/promises";
import { createEngine } from "../src/engine.js";
const engine = await createEngine(
  await readFile(
    new URL(
      "../target/wasm32-unknown-unknown/release/muzpad_wasm.wasm",
      import.meta.url,
    ),
  ),
);
const project = new URL("../../muz-projects/still-our-own/", import.meta.url);
const files = {};
for (const name of await readdir(project))
  if (name.endsWith(".muz"))
    files[name] = await readFile(new URL(name, project), "utf8");
let start = performance.now();
const compiled = engine.call({ command: "compile", files, entry: "song.muz" });
console.log("compile ms", Math.round(performance.now() - start));
start = performance.now();
const status = engine.call({
  command: "load",
  snapshot: compiled.snapshot,
  rate: 48000,
});
console.log(
  "prepare ms",
  Math.round(performance.now() - start),
  "duration",
  status.duration,
);
engine.call({ command: "seek", beat: 96 });
start = performance.now();
let peak = 0;
for (let i = 0; i < 250; i++) {
  engine.call({ command: "render", frames: 1024 });
  for (const sample of engine.audio(1024)) {
    if (!Number.isFinite(sample)) throw new Error("non-finite PCM");
    peak = Math.max(peak, Math.abs(sample));
  }
}
console.log(
  "rendered seconds",
  (250 * 1024) / 48000,
  "wall ms",
  Math.round(performance.now() - start),
  "peak",
  peak,
  "memory MiB",
  engine.memoryBytes() / 1048576,
);
