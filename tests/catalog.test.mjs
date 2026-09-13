import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalog } from "../scripts/catalog.mjs";
test("build manifest supports multiple arbitrary projects, alternate entries, and no projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "muzpad-catalog-"));
  try {
    for (const dir of [
      "core/std",
      "core/docs",
      "core/contrib/nested/pack",
      "alpha/assets",
      "beta",
    ])
      await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, "core/docs/guide.md"), "# Guide");
    await writeFile(join(root, "core/contrib/nested/pack/README.md"), "# Pack");
    await writeFile(
      join(root, "core/contrib/nested/pack/voice.muz"),
      "fn voice() = sample([]);",
    );
    for (const path of [
      "alpha/main.muz",
      "alpha/short.muz",
      "beta/other.muz",
      "alpha/assets/excluded.muz",
    ])
      await writeFile(join(root, path), "// source");
    const config = {
      core: "core",
      demos: [
        {
          id: "alpha",
          directory: "alpha",
          entry: "main.muz",
          entries: ["short.muz"],
        },
        { id: "beta", directory: "beta", entry: "other.muz" },
      ],
    };
    const path = join(root, "build.json");
    await writeFile(path, JSON.stringify(config));
    const catalog = await buildCatalog(path);
    assert.equal(catalog.demos.length, 2);
    assert.deepEqual(catalog.demos[0].entries, ["main.muz", "short.muz"]);
    assert.equal(catalog.demos[0].files["assets/excluded.muz"], undefined);
    assert.deepEqual(catalog.packages[0].requirements, ["External samples"]);
    config.demos = [];
    await writeFile(path, JSON.stringify(config));
    assert.deepEqual((await buildCatalog(path)).demos, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
