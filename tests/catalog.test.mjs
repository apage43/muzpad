import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalog } from "../scripts/catalog.mjs";
test("catalog includes gist links without bundling pieces, plus the full core tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "muzpad-catalog-"));
  try {
    for (const dir of ["core/std", "core/docs", "core/contrib/nested/pack"])
      await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, "core/README.md"), "# muz");
    await writeFile(join(root, "core/docs/guide.md"), "# Guide");
    await writeFile(join(root, "core/contrib/nested/pack/README.md"), "# Pack");
    await writeFile(
      join(root, "core/contrib/nested/pack/voice.muz"),
      "fn voice() = sample([]);",
    );
    const config = {
      core: "core",
      gists: [{ gist: "a".repeat(32), title: "A piece" }],
    };
    const path = join(root, "build.json");
    await writeFile(path, JSON.stringify(config));
    const catalog = await buildCatalog(path);
    assert.equal(catalog.gists.length, 1);
    assert.equal(catalog.gists[0].files, undefined);
    assert.equal(catalog.demos, undefined);
    assert.equal(catalog.libraries["core/docs/guide.md"], undefined);
    assert.equal(catalog.libraries["docs/guide.md"], "# Guide");
    assert.deepEqual(catalog.packages[0].requirements, ["External samples"]);
    config.gists = [];
    await writeFile(path, JSON.stringify(config));
    assert.deepEqual((await buildCatalog(path)).gists, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
