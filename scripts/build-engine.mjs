import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { writeCatalog } from "./catalog.mjs";
import {
  buildConfig,
  coreState,
  sha256,
  verifyCoreDependency,
} from "./core-build.mjs";
const root = resolve(import.meta.dirname, "..");
const config = await buildConfig(root);
await verifyCoreDependency(root, config.core);
const before = coreState(config.core);
await mkdir(resolve(root, "public"), { recursive: true });
execFileSync(
  "cargo",
  ["build", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", resolve(root, "target")],
  { cwd: root, stdio: "inherit" },
);
const wasm = resolve(root, "public/muz.wasm");
await copyFile(
  resolve(root, "target/wasm32-unknown-unknown/release/muzpad_wasm.wasm"),
  wasm,
);
await writeCatalog(root);
const after = coreState(config.core);
if (JSON.stringify(before) !== JSON.stringify(after))
  throw new Error(
    "muz-core changed during the build. Rebuild against a stable checkout.",
  );
const build = {
  commit: after.commit,
  clean: !after.changes,
  wasmSha256: sha256(await readFile(wasm)),
};
await writeFile(
  resolve(root, "public/engine-build.json"),
  JSON.stringify(build),
);
const catalogPath = resolve(root, "public/catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
catalog.engine = { commit: build.commit, clean: build.clean };
await writeFile(catalogPath, JSON.stringify(catalog));
