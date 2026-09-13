import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGist } from "../src/gist.js";

export async function sources(dir, prefix = "") {
  const files = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (
      entry.name.startsWith(".") ||
      ["assets", "out", "node_modules", "target", "dist"].includes(entry.name)
    )
      continue;
    const name = prefix + entry.name;
    if (entry.isDirectory())
      Object.assign(files, await sources(resolve(dir, entry.name), name + "/"));
    else if (
      entry.isFile() &&
      [".muz", ".md"].includes(extname(entry.name).toLowerCase())
    )
      files[name] = await readFile(resolve(dir, entry.name), "utf8");
  }
  return files;
}
export async function buildCatalog(configPath) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const root = dirname(configPath),
    core = resolve(root, config.core);
  const libraries = {
    "README.md": await readFile(resolve(core, "README.md"), "utf8"),
    ...(await sources(resolve(core, "std"), "std/")),
    ...(await sources(resolve(core, "contrib"), "contrib/")),
    ...(await sources(resolve(core, "docs"), "docs/")),
    ...(await sources(resolve(core, "examples"), "examples/")),
  };
  const packages = Object.keys(libraries)
    .filter((p) => p.startsWith("contrib/") && p.endsWith("/README.md"))
    .map((readme) => {
      const directory = dirname(readme);
      const code = Object.entries(libraries)
        .filter(([p]) => p.startsWith(directory + "/") && p.endsWith(".muz"))
        .map(([, s]) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""))
        .join("\n");
      const requirements = [];
      if (/\bsample\s*\(/.test(code)) requirements.push("External samples");
      if (/\b(?:plugin|vst3|clap)\s*\(/.test(code))
        requirements.push("Native plugins");
      return { directory, readme, requirements };
    });
  const gists = (config.gists ?? []).map((item) => ({
    gist: parseGist(item.gist),
    title: item.title || "Untitled gist",
    description: item.description || "",
  }));
  return { libraries, packages, gists };
}
export async function writeCatalog(root) {
  const config = resolve(
    root,
    process.env.MUZPAD_BUILD_CONFIG || "build.config.json",
  );
  const catalog = await buildCatalog(config);
  await mkdir(resolve(root, "public"), { recursive: true });
  await writeFile(
    resolve(root, "public/catalog.json"),
    JSON.stringify(catalog),
  );
  console.log(
    `Catalog: ${catalog.gists.length} gist link(s), ${Object.keys(catalog.libraries).length} library files`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await writeCatalog(resolve(import.meta.dirname, ".."));
