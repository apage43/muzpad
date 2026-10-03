import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { sha256 } from "./core-build.mjs";

const excluded = new Set(["assets", "out", "target", "dist", "node_modules", "__pycache__", "cache"]);
const textExtensions = new Set([".muz", ".md", ".json", ".txt", ".toml", ".yaml", ".yml", ".ini", ".cfg"]);

export function isDesktopResource(path) {
  const parts = path.split("/");
  if (parts.some((part) => part.startsWith(".") || excluded.has(part))) return false;
  if (/^(?:README|LICENSE|COPYING|NOTICE)(?:\.[^/]+)?$/.test(path)) return true;
  return ["contrib", "docs", "std", "examples"].includes(parts[0]) && textExtensions.has(extname(path).toLowerCase());
}

export async function stageLibrary(root, core, revision) {
  // Read committed Git blobs, never mutable checkout/user library contents.
  const entries = execFileSync("git", ["-C", core, "ls-tree", "-r", "-z", "--full-tree", revision], { encoding: "utf8" })
    .split("\0").filter(Boolean).map((entry) => {
      const tab = entry.indexOf("\t");
      return { mode: entry.slice(0, tab).split(" ")[0], path: entry.slice(tab + 1) };
    }).filter((entry) => isDesktopResource(entry.path));
  const paths = entries.map((entry) => entry.path).sort();
  for (const entry of entries) {
    if (!["100644", "100755"].includes(entry.mode)) throw new Error(`Core resource is not a regular file: ${entry.path}`);
  }
  for (const required of ["README.md", "contrib/README.md", "docs/README.md", "std/prelude.muz"]) {
    if (!paths.includes(required)) throw new Error(`Pinned core resource is missing: ${required}`);
  }
  const parent = resolve(root, "src-tauri/resources");
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(resolve(parent, "library-stage-"));
  const files = [];
  try {
    for (const path of paths) {
      const bytes = execFileSync("git", ["-C", core, "show", `${revision}:${path}`], { maxBuffer: 16 * 1024 * 1024 });
      const destination = resolve(temporary, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
      files.push({ path, sha256: sha256(bytes) });
    }
    await writeFile(resolve(temporary, "build.json"), JSON.stringify({ coreRevision: revision, protocolVersion: 1, files }, null, 2) + "\n");
    await rm(resolve(parent, "library"), { recursive: true, force: true });
    await rename(temporary, resolve(parent, "library"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(`Desktop library: ${files.length} pinned text resources (no samples/plugins/preset state)`);
  return files;
}
