import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { buildConfig, coreState, sha256, verifyCoreDependency } from "./core-build.mjs";
import { writeCatalog } from "./catalog.mjs";
import { stageLibrary } from "./desktop-resources.mjs";

const root = resolve(import.meta.dirname, "..");
const native = resolve(root, "src-tauri");
const cli = resolve(root, "node_modules/@tauri-apps/cli/tauri.js");
const command = process.argv[2];
const args = process.argv.slice(3);
if (!["resources", "prepare", "dev", "build", "package", "release"].includes(command)) {
  throw new Error("Use desktop:resources, desktop:prepare, desktop:dev, desktop:build, desktop:package or desktop:release.");
}
let target = process.env.CARGO_BUILD_TARGET;
let debug = command === "dev";
let bundles;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--target" && args[index + 1]) target = args[++index];
  else if (args[index] === "--debug") debug = true;
  else if (args[index] === "--bundles" && args[index + 1]) bundles = args[++index].split(",");
  else throw new Error(`Unknown desktop argument: ${args[index]}`);
}
if (process.platform !== "linux") throw new Error("Desktop packaging currently targets Linux only.");
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
const triple = target || host;
if (!triple || !/^[a-z0-9_]+-[a-z0-9_-]*linux[a-z0-9_-]*$/.test(triple)) throw new Error("Choose a Rust Linux target triple with --target.");
if (command === "release" && debug) throw new Error("Releases require the release profile.");
if (bundles && (!bundles.length || bundles.some((bundle) => !["deb", "appimage"].includes(bundle)))) throw new Error("Supported bundles: deb,appimage.");
if (bundles && !["package", "release"].includes(command)) throw new Error("--bundles is only valid for package/release.");
const profile = debug ? "debug" : "release";
const targetDir = resolve(root, process.env.CARGO_TARGET_DIR || "src-tauri/target");
const output = resolve(targetDir, ...(target ? [triple] : []), profile);
const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
const run = (program, arguments_) => execFileSync(program, arguments_, { cwd: root, env, stdio: "inherit" });
const revision = (await readFile(resolve(native, "core-revision"), "utf8")).trim();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("src-tauri/core-revision must contain a full verified Git SHA.");
if (env.MUZPAD_CORE_REVISION && env.MUZPAD_CORE_REVISION !== revision) throw new Error("MUZPAD_CORE_REVISION does not match src-tauri/core-revision.");
env.MUZPAD_CORE_REVISION = revision;
env.MUZPAD_CATALOG_CORE = resolve(native, "resources/library");
const config = await buildConfig(root);
await verifyCoreDependency(root, config.core, resolve(native, "Cargo.toml"));
await verifyCoreDependency(root, config.core);
function assertPinnedCore() {
  const state = coreState(config.core);
  const changed = execFileSync("git", ["-C", config.core, "diff", "--name-only", "-z", revision], { encoding: "utf8" }).split("\0").filter(Boolean);
  const untracked = execFileSync("git", ["-C", config.core, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  if (state.commit !== revision || [...changed, ...untracked].some((path) => !path.startsWith("docs/"))) {
    throw new Error(`Desktop requires muz-core source/config at ${revision}; only noncompiled docs may have local edits.`);
  }
}
assertPinnedCore();
await stageLibrary(root, config.core, revision);
const catalogEnv = process.env.MUZPAD_CATALOG_CORE;
process.env.MUZPAD_CATALOG_CORE = env.MUZPAD_CATALOG_CORE;
try {
  await writeCatalog(root, { commit: revision, clean: !coreState(config.core).changes });
} finally {
  if (catalogEnv === undefined) delete process.env.MUZPAD_CATALOG_CORE;
  else process.env.MUZPAD_CATALOG_CORE = catalogEnv;
}
assertPinnedCore();
if (command === "resources") process.exit(0);
run("cargo", ["build", "--manifest-path", resolve(native, "Cargo.toml"), "--locked", "--no-default-features", "--bin", "muzpad-engine", ...(debug ? [] : ["--release"]), ...(target ? ["--target", triple] : [])]);
assertPinnedCore();
const engine = resolve(output, "muzpad-engine");
const sidecar = resolve(native, `binaries/muzpad-engine-${triple}`);
await mkdir(resolve(native, "binaries"), { recursive: true });
await copyFile(engine, sidecar);
await chmod(sidecar, 0o755);
console.log(`Desktop sidecar: ${relative(root, sidecar)} (${profile}, core ${revision})`);
if (command === "prepare") process.exit(0);
const targetArgs = target ? ["--target", triple] : [];
if (command === "dev") {
  // No Vite or Tauri static HTTP server: use the embedded trusted production UI.
  run(process.execPath, [cli, "dev", "--no-dev-server", "--no-watch", ...targetArgs, "--", "--locked"]);
} else {
  if (command === "release") {
    for (const bundle of bundles || ["deb", "appimage"]) {
      await rm(resolve(output, "bundle", bundle), { recursive: true, force: true });
    }
  }
  run(process.execPath, [cli, "build", ...targetArgs, ...(debug ? ["--debug"] : []), ...(command === "build" ? ["--no-bundle"] : []), ...(bundles ? ["--bundles", bundles.join(",")] : []), "--", "--locked"]);
}
assertPinnedCore();
if (command !== "release") process.exit(0);
const destination = resolve(root, config.desktop?.releaseDirectory || ".artifacts/desktop", triple);
const artifactsRoot = resolve(root, ".artifacts") + sep;
if (!destination.startsWith(artifactsRoot)) throw new Error("desktop.releaseDirectory must be inside .artifacts/.");
await mkdir(destination, { recursive: true });
async function packageFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await packageFiles(path));
    else if (entry.isFile() && /\.(?:deb|AppImage)$/.test(entry.name)) paths.push(path);
  }
  return paths.sort();
}
const requested = bundles || ["deb", "appimage"];
const packages = (await packageFiles(resolve(output, "bundle"))).filter((path) => requested.includes(path.endsWith(".deb") ? "deb" : "appimage"));
for (const bundle of requested) {
  if (!packages.some((path) => path.endsWith(bundle === "deb" ? ".deb" : ".AppImage"))) throw new Error(`Tauri did not produce the requested ${bundle} package.`);
}
const files = [];
for (const source of packages) {
  const name = basename(source);
  await copyFile(source, resolve(destination, name));
  const bytes = await readFile(resolve(destination, name));
  files.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
}
const lockHashes = {};
for (const path of ["package-lock.json", "Cargo.lock", "src-tauri/Cargo.lock"]) lockHashes[path] = sha256(await readFile(resolve(root, path)));
await writeFile(resolve(destination, "release.json"), JSON.stringify({
  version: JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version,
  coreRevision: revision, protocolVersion: 1, target: triple,
  hostRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  hostChanges: execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).trim(),
  rustc: execFileSync("rustc", ["-vV"], { encoding: "utf8" }).trim(),
  node: process.version, lockHashes, engineSha256: sha256(await readFile(sidecar)),
  libraryManifestSha256: sha256(await readFile(resolve(native, "resources/library/build.json"))), files,
}, null, 2) + "\n");
await writeFile(resolve(destination, "SHA256SUMS"), files.map((file) => `${file.sha256}  ${file.name}\n`).join(""));
console.log(`Local release artifacts: ${relative(root, destination)} (not uploaded or deployed)`);
