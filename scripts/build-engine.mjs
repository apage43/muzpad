import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { writeCatalog } from "./catalog.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(resolve(root, "public"), { recursive: true });
execFileSync(
  "cargo",
  ["build", "--release", "--target", "wasm32-unknown-unknown"],
  { cwd: root, stdio: "inherit" },
);
await copyFile(
  resolve(root, "target/wasm32-unknown-unknown/release/muzpad_wasm.wasm"),
  resolve(root, "public/muz.wasm"),
);
await writeCatalog(root);
