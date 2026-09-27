import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

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
