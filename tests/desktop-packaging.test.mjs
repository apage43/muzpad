import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDesktopResource, stageLibrary } from "../scripts/desktop-resources.mjs";

test("desktop resource allowlist excludes downloaded samples, binaries, preset state and caches", () => {
  for (const path of ["README.md", "LICENSE", "std/prelude.muz", "docs/guide.md", "contrib/kit/manifest.json", "contrib/kit/nested/config.toml", "examples/song.muz"]) assert.equal(isDesktopResource(path), true, path);
  for (const path of ["", "contrib/kit/assets/manifest.json", "contrib/kit/__pycache__/notes.md", "contrib/kit/.cache/index.json", "contrib/plugins/preset.ptm", "contrib/plugins/synth.clap", "contrib/plugins/synth.vst3", "contrib/kit/install.py", "config/plugins.json", "contrib/kit/sample.wav"]) assert.equal(isDesktopResource(path), false, path);
});

test("desktop staging preserves tracked module-relative JSON/docs and replaces obsolete generated resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "muzpad-packaging-"));
  const core = join(root, "core");
  const commit = () => execFileSync("git", ["-C", core, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
  try {
    await mkdir(core);
    const resources = {
      "README.md": "core", "LICENSE": "license", "contrib/README.md": "packs",
      "docs/README.md": "docs", "std/prelude.muz": "let a = 1;",
      "contrib/kit/nested/instrument.muz": "let a = 2;",
      "contrib/kit/nested/manifest.json": '{"relative":"assets/sample.wav"}',
      "contrib/kit/assets/secret.json": "not redistributed",
      "contrib/plugins/preset.ptm": "licensed preset",
    };
    for (const [path, content] of Object.entries(resources)) {
      await mkdir(dirname(join(core, path)), { recursive: true });
      await writeFile(join(core, path), content);
    }
    execFileSync("git", ["init", "--quiet", core]);
    execFileSync("git", ["-C", core, "add", "."]);
    commit();
    const revision = execFileSync("git", ["-C", core, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await writeFile(join(core, "docs/README.md"), "user documentation edit");
    await writeFile(join(core, "contrib/kit/nested/manifest.json"), "mutable checkout content");
    await writeFile(join(core, "contrib/untracked.muz"), "user content");
    const library = join(root, "src-tauri/resources/library");
    await mkdir(library, { recursive: true });
    await writeFile(join(library, "obsolete.muz"), "obsolete");
    const files = await stageLibrary(root, core, revision);
    assert.equal(await readFile(join(library, "contrib/kit/nested/manifest.json"), "utf8"), resources["contrib/kit/nested/manifest.json"]);
    assert.equal(await readFile(join(library, "LICENSE"), "utf8"), "license");
    assert.equal(await readFile(join(library, "docs/README.md"), "utf8"), "docs");
    assert.equal(await readFile(join(core, "docs/README.md"), "utf8"), "user documentation edit");
    for (const path of ["obsolete.muz", "contrib/untracked.muz", "contrib/kit/assets/secret.json", "contrib/plugins/preset.ptm"]) await assert.rejects(access(join(library, path)), { code: "ENOENT" });
    const manifest = JSON.parse(await readFile(join(library, "build.json"), "utf8"));
    assert.equal(manifest.coreRevision, revision);
    assert.equal(manifest.protocolVersion, 1);
    assert.deepEqual(manifest.files, files);
    assert.ok(files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));
    await symlink(join(core, "README.md"), join(core, "contrib/symlink.md"));
    execFileSync("git", ["-C", core, "add", "contrib/symlink.md"]);
    commit();
    const symlinkRevision = execFileSync("git", ["-C", core, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await assert.rejects(stageLibrary(root, core, symlinkRevision), /not a regular file/);
    assert.equal(await readFile(join(library, "LICENSE"), "utf8"), "license");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
