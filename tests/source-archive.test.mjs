import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coreState,
  sha256,
  createSourceArchive,
} from "../scripts/source-archive.mjs";
test("archive captures the recorded commit and refuses dirty or mismatched source/WASM", async () => {
  const root = await mkdtemp(join(tmpdir(), "muzpad-archive-"));
  try {
    const core = join(root, "core");
    await mkdir(core);
    const git = (args) =>
      execFileSync("git", ["-C", core, ...args], { stdio: "pipe" });
    git(["init"]);
    await writeFile(join(core, "source.muz"), "source at build time");
    git(["add", "."]);
    git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "source",
    ]);
    const wasm = join(root, "muz.wasm");
    await writeFile(wasm, "synthetic wasm");
    const build = {
      commit: coreState(core).commit,
      clean: true,
      wasmSha256: sha256(await readFile(wasm)),
    };
    const archive = await createSourceArchive(
      core,
      build,
      wasm,
      join(root, "out"),
    );
    assert.equal(
      execFileSync(
        "tar",
        ["-xOzf", archive, `muz-core-${build.commit}/source.muz`],
        { encoding: "utf8" },
      ),
      "source at build time",
    );
    await writeFile(join(core, "source.muz"), "uncommitted source");
    await assert.rejects(
      createSourceArchive(core, build, wasm, join(root, "out")),
      /same clean/,
    );
    git(["restore", "source.muz"]);
    await writeFile(wasm, "different wasm");
    await assert.rejects(
      createSourceArchive(core, build, wasm, join(root, "out")),
      /does not match/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
