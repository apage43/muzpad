import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, realpath, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export async function buildConfig(root) {
  const path = resolve(
    root,
    process.env.MUZPAD_BUILD_CONFIG || "build.config.json",
  );
  const config = JSON.parse(await readFile(path, "utf8"));
  return {
    ...config,
    core: await realpath(resolve(dirname(path), config.core)),
  };
}
export function coreState(core) {
  const git = (args) =>
    execFileSync("git", ["-C", core, ...args], { encoding: "utf8" }).trim();
  return {
    commit: git(["rev-parse", "HEAD"]),
    changes: git(["status", "--porcelain", "--untracked-files=all"]),
  };
}
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export async function verifyCoreDependency(root, core) {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  const dependency = metadata.packages
    .flatMap((p) => p.dependencies)
    .find((d) => d.name === "muz");
  if (!dependency?.path || (await realpath(dependency.path)) !== core)
    throw new Error(
      "build.config.json core must match the muz dependency used by the WASM crate.",
    );
}

export async function createSourceArchive(core, build, wasm, directory) {
  const current = coreState(core);
  if (!build.clean || current.changes || current.commit !== build.commit)
    throw new Error(
      "Source archives require the same clean muz-core commit used for the WASM build. Commit engine changes, then rebuild.",
    );
  if (sha256(await readFile(wasm)) !== build.wasmSha256)
    throw new Error(
      "WASM does not match the recorded engine build. Rebuild before archiving.",
    );
  await mkdir(directory, { recursive: true });
  const shortHash = execFileSync(
    "git",
    ["-C", core, "rev-parse", "--short", build.commit],
    { encoding: "utf8" },
  ).trim();
  const name = `muz-core-${shortHash}`;
  const path = resolve(directory, `${name}.tgz`),
    tar = `${path}.tar`;
  try {
    execFileSync("git", [
      "-C",
      core,
      "archive",
      "--format=tar",
      `--prefix=${name}/`,
      "-o",
      tar,
      build.commit,
    ]);
    await writeFile(path, gzipSync(await readFile(tar), { level: 9 }));
  } finally {
    await rm(tar, { force: true });
  }
  return path;
}
