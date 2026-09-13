// Publishing happens only when this command is explicitly invoked.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildConfig,
  coreState,
  createSourceArchive,
} from "./source-archive.mjs";
const root = resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
for (const arg of args)
  if (!["--source-archive", "--dry-run"].includes(arg))
    throw new Error(`Unknown option ${arg}`);
const archive = args.has("--source-archive"),
  dryRun = args.has("--dry-run");
const config = await buildConfig(root);
if (archive && coreState(config.core).changes)
  throw new Error(
    "Commit muz-core changes before deploying with --source-archive.",
  );
const destination = config.sourceArchive;
if (
  archive &&
  (!destination?.bucket ||
    !destination?.prefix ||
    !destination?.baseUrl?.startsWith("https://"))
)
  throw new Error(
    "Configure sourceArchive bucket, prefix, and HTTPS baseUrl in the build configuration.",
  );
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
if (archive) {
  const build = JSON.parse(
    await readFile(resolve(root, "dist/engine-build.json"), "utf8"),
  );
  const path = await createSourceArchive(
    config.core,
    build,
    resolve(root, "dist/muz.wasm"),
    resolve(root, ".artifacts"),
  );
  const key = `${destination.prefix.replace(/\/$/, "")}/${build.commit}.tgz`;
  const url = `${destination.baseUrl.replace(/\/$/, "")}/${build.commit}.tgz`;
  if (dryRun)
    console.log(
      `Dry run: created ${path}; would upload to ${destination.bucket}/${key} and link ${url}`,
    );
  else {
    execFileSync(
      "npx",
      [
        "wrangler",
        "r2",
        "object",
        "put",
        `${destination.bucket}/${key}`,
        "--file",
        path,
        "--remote",
        "--content-type",
        "application/gzip",
        "--content-disposition",
        `attachment; filename="${build.commit}.tgz"`,
        "--cache-control",
        "public, max-age=31536000, immutable",
      ],
      { cwd: root, stdio: "inherit" },
    );
    const check = await fetch(url, { method: "HEAD" });
    if (!check.ok)
      throw new Error(
        `Archive uploaded but ${url} is not accessible (${check.status}); site was not deployed.`,
      );
    const path = resolve(root, "dist/catalog.json");
    const catalog = JSON.parse(await readFile(path, "utf8"));
    catalog.engine.sourceArchive = url;
    await writeFile(path, JSON.stringify(catalog));
  }
}
if (dryRun) console.log("Dry run complete. No R2 upload or live deployment.");
else
  execFileSync("npx", ["wrangler", "deploy"], { cwd: root, stdio: "inherit" });
