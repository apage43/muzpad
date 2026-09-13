import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixture = {
  id: "browser-project",
  title: "Browser project",
  entry: "song.muz",
  files: {
    "song.muz": 'use "production.muz" as p; p.main',
    "production.muz": `use "std/synthesis" as s;
let main = song({title: "Browser project", tempo: 120,
  sections: [{name: "opening", duration: 8b}, {name: "answer", duration: 8b}],
  tracks: [track("lead", phrase("C4:q E4:q G4:q B4:q").repeat(4), s.pluck())],
  automation: [{target: "lead.out", curve: curve([[0b, -6], [8b, 0], [16b, -6]], "smooth")}],
  tail: 0.1});`,
  },
};
test.beforeEach(async ({ page }) => {
  await page.addInitScript((value) => {
    if (!localStorage.getItem("muzpad-draft-v1"))
      localStorage.setItem("muzpad-draft-v1", JSON.stringify(value));
  }, fixture);
});

test("static deployment: playback, rejected edits, source navigation, views, and export", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#build-detail")).toContainText("1 tracks");
  await page.locator("#play").click();
  await expect(page.locator("#clock")).not.toHaveText("0:00", {
    timeout: 8000,
  });
  await expect(page.locator("#audio-health")).toHaveText("Audio running");
  // Break an imported source while accepted playback continues.
  await page.locator('[data-file="production.muz"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("bad_symbol();\n");
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Needs attention");
  await expect(page.locator("#diagnostic-list")).toContainText("bad_symbol");
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  await page.locator("[data-diagnostic]").click();
  await expect(page.locator("#source-path")).toHaveText("production.muz");
  // Undo and recompile without losing the accepted snapshot.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Backspace");
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#play").click();
  await page.locator("#section").selectOption("1");
  await expect(page.locator("#clock")).toHaveText("0:04");
  await page.locator("#loop").click();
  await expect(page.locator("#loop")).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-view="routing"]').click();
  await expect(page.locator(".network")).toBeVisible();
  await page.locator(".network [data-source]").first().click();
  await expect(page.locator("#source-path")).not.toHaveText("song.muz");
  await page.locator('[data-view="patch"]').click();
  await expect(page.locator(".network rect").first()).toBeVisible();
  await page.locator('[data-view="automation"]').click();
  await expect(page.locator(".automation-lane").first()).toBeVisible();
  // All interface typography is proportional, including the editor gutters.
  for (const selector of [
    ".brand",
    "#clock",
    ".file",
    ".view-tabs button",
    "#source-path",
    ".cm-gutters",
  ]) {
    expect(
      await page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).fontFamily),
    ).not.toMatch(/mono|Consolas|Courier/i);
  }
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("browser-project.zip");
  const archivePath = await download.path();
  await page.locator("#new-project").click();
  await page.locator("#zip-input").setInputFiles(archivePath!);
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#build-detail")).toContainText("1 tracks");
  expect(errors).toEqual([]);
});

test("new project, local draft recovery, and switchable paper theme", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#new-project").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#build-detail")).toContainText("1 tracks");
  await page.reload();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#project-title")).toHaveText("Untitled project");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("folder import retains relative modules and switches the entry file", async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "muzpad-import-"));
  try {
    await writeFile(join(dir, "song.muz"), fixture.files["song.muz"]);
    await writeFile(
      join(dir, "production.muz"),
      fixture.files["production.muz"],
    );
    await page.goto("./");
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await page.locator("#folder-input").setInputFiles(dir);
    await expect(page.locator('[data-file="production.muz"]')).toBeVisible();
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await page.locator('[data-file="production.muz"]').click();
    await page.locator("#set-entry").click();
    await expect(page.locator("#entry-notice")).toHaveText(
      "Rebuild to use production.muz · song.muz is still active",
    );
    await expect(page.locator("#entry-label")).toHaveText(
      "Active entry: song.muz",
    );
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await page.locator("#run").click();
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await expect(page.locator("#entry-label")).toHaveText(
      "Entry: production.muz",
    );
    await expect(page.locator("#entry-notice")).toBeHidden();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("arrangement navigation stays usable at deep zoom and follows only when enabled", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  const viewport = page.locator("#arrangement");
  const canvas = viewport.locator("canvas");
  // A 512× timeline must not allocate a 512× bitmap.
  await page.locator("#zoom").focus();
  await page.keyboard.press("End");
  await expect(page.locator("#zoom-value")).toHaveText("512×");
  const bounds = await viewport.boundingBox();
  const geometry = await viewport.evaluate((el) => ({
    width: el.clientWidth,
    scroll: el.scrollWidth,
    bitmap: el.querySelector("canvas")!.width,
    ratio: devicePixelRatio,
  }));
  expect(geometry.scroll).toBeGreaterThan(geometry.width * 200);
  expect(geometry.bitmap).toBeLessThanOrEqual(
    Math.ceil(geometry.width * Math.min(2, geometry.ratio)),
  );
  // The ruler canvas stays at the viewport origin, even far into the timeline.
  expect(Math.abs((await canvas.boundingBox())!.x - bounds!.x)).toBeLessThan(2);
  const anchorX = 260;
  const fraction = () =>
    viewport.evaluate(
      (el, x) => (el.scrollLeft + x - 130) / (el.scrollWidth - 142),
      anchorX,
    );
  const before = await fraction();
  await page.mouse.move(bounds!.x + anchorX, bounds!.y + 110);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 90);
  await page.keyboard.up("Control");
  await expect.poll(fraction).toBeCloseTo(before, 4);
  await expect(page.locator("#zoom-value")).not.toHaveText("512×");
  // Follow reveals the playhead as audio advances, then yields to an intentional drag.
  await page.locator("#follow").click(); // off
  await page.locator("#follow").click(); // on; center the initial playhead
  await page.locator("#play").click();
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(100);
  await page.mouse.move(bounds!.x + 330, bounds!.y + 110);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 380, bounds!.y + 110, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#follow")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const panned = await viewport.evaluate((el) => el.scrollLeft);
  await page.waitForTimeout(160);
  expect(await viewport.evaluate((el) => el.scrollLeft)).toBe(panned);
  await page.locator("#follow").click();
  await expect(page.locator("#follow")).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollLeft))
    .not.toBe(panned);
  await page.locator("#play").click();
  await page.locator("#zoom-fit").click();
  await expect(page.locator("#zoom-value")).toHaveText("1×");
  expect(await viewport.evaluate((el) => el.scrollLeft)).toBe(0);
  // Panning didn't turn a drag into a seek; ordinary ruler clicks still seek.
  const fitted = await viewport.evaluate((el) => el.clientWidth);
  await canvas.click({ position: { x: 130 + (fitted - 142) * 0.51, y: 43 } });
  await expect(page.locator("#clock")).toHaveText("0:04");
  await canvas.click({
    position: { x: 130 + ((fitted - 142) * 0.5) / 16, y: 85 },
  });
  await expect(page.locator("#selection-label")).toContainText("C4");
});

test("muz-core groups its sources and docs, and Markdown renders safely with local navigation", async ({
  page,
}) => {
  await page.addInitScript((base) => {
    localStorage.setItem(
      "muzpad-draft-v1",
      JSON.stringify({
        ...base,
        files: {
          ...base.files,
          "README.md": `# Project guide

Read the **instructions**, then [continue](notes/guide.md#examples) or [open source](production.muz#L2).

| Control | Meaning |
| --- | --- |
| Play | Start music |

- First item
- Second item

\`\`\`muz
let note = phrase("C4:q");
\`\`\`

<script>window.markdownExecuted = true</script>
<img src=x onerror="window.markdownExecuted = true">
<a href="javascript:window.markdownExecuted=true">unsafe link</a>
<div id="run" style="position:fixed">Plain content</div>`,
          "notes/guide.md": `# Further reading\n\n[Back](../README.md)\n\n${"A paragraph.\n\n".repeat(60)}## Examples\n\nThe destination.`,
        },
      }),
    );
  }, fixture);
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  const core = page.locator(".core-tree");
  await expect(core.locator(":scope > summary")).toHaveText("muz-core");
  await expect(core.locator(":scope > details")).toHaveCount(4);
  await core.locator('[data-core-folder="docs"] > summary').click();
  await core.locator('[data-file="docs/embedding.md"]').click();
  await expect(page.locator("#document h1")).toHaveText("Embedding muz");
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#format")).toBeDisabled();
  await page.locator("#file-search").fill("std/synthesis");
  await core.locator('[data-file="std/synthesis.muz"]').click();
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#source-mode")).toHaveText("muz-core · read only");
  await page.locator("#file-search").fill("");
  await page.locator('[data-file="README.md"][data-kind="project"]').click();
  const doc = page.locator("#document");
  await expect(doc.locator("h1")).toHaveText("Project guide");
  await expect(doc.locator("strong")).toHaveText("instructions");
  await expect(doc.locator("table tbody td")).toHaveCount(2);
  await expect(doc.locator("ul li")).toHaveCount(2);
  await expect(doc.locator("pre code")).toContainText('phrase("C4:q")');
  expect(
    await doc
      .locator("p")
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily),
  ).not.toMatch(/mono|Consolas|Courier/i);
  await expect(
    doc.locator("script, img, [style], [id=run], a[href^='javascript:']"),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).markdownExecuted),
  ).toBeUndefined();
  await doc.getByRole("link", { name: "continue" }).click();
  await expect(page.locator("#source-path")).toHaveText("notes/guide.md");
  expect(await doc.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await doc.getByRole("link", { name: "Back", exact: true }).click();
  await expect(page.locator("#source-path")).toHaveText("README.md");
  await doc.getByRole("link", { name: "open source" }).click();
  await expect(page.locator("#source-path")).toHaveText("production.muz");
  await expect(page.locator("#editor")).toBeVisible();
  await expect(doc).toBeHidden();
});

test("nested libraries, entry selection, inspector visibility, and analysis source", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#run")).toContainText("Rebuild");
  await page.locator('[data-core-folder="contrib"] > summary').click();
  await page
    .locator('[data-folder="library:contrib/unreal"] > summary')
    .click();
  await page
    .locator('[data-folder="library:contrib/unreal/metal-gtx"] > summary')
    .click();
  await expect(
    page.locator('[data-file="contrib/unreal/metal-gtx/metal-gtx.muz"]'),
  ).toBeVisible();
  await page
    .locator('[data-file="contrib/unreal/metal-gtx/metal-gtx.muz"]')
    .click();
  await expect(page.locator("#requirements")).toContainText("External samples");
  await page.locator("#entry-select").selectOption("production.muz");
  await expect(page.locator("#source-path")).toHaveText("production.muz");
  await expect(page.locator("#entry-label")).toHaveText(
    "Active entry: song.muz",
  );
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#toggle-inspector").click();
  await expect(page.locator("#inspector")).toBeHidden();
  await page.locator("#analysis-source").selectOption("lead");
  await expect(page.locator("#analysis-detail")).toHaveText(
    "Track output · before buses",
  );
  const silent = await page
    .locator("#scope")
    .evaluate((el: HTMLCanvasElement) => el.toDataURL());
  await page.locator("#play").click();
  await expect
    .poll(() =>
      page
        .locator("#scope")
        .evaluate((el: HTMLCanvasElement) => el.toDataURL()),
    )
    .not.toBe(silent);
  await page.locator("#analysis-source").selectOption("");
  await expect(page.locator("#analysis-detail")).toHaveText("Master output");
});

test("mounted folder saves source and new files, and refuses external changes", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Writable directory picker integration targets supporting browsers",
  );
  await page.addInitScript(() => {
    // Real browser file handles and writable streams; only the OS picker and its permission UI are substituted.
    const setup = async () => {
      const root = await navigator.storage.getDirectory();
      const song = await root.getFileHandle("song.muz", { create: true });
      const writer = await song.createWritable();
      await writer.write(
        'use "std/synthesis" as s; song({tracks: [track("tone", phrase("C4:q"), s.pluck())]})',
      );
      await writer.close();
      return root;
    };
    let mounted: Promise<FileSystemDirectoryHandle> | undefined;
    (window as any).showDirectoryPicker = async () => {
      const root = await (mounted ??= setup());
      return {
        kind: "directory",
        name: "Mounted project",
        values: async function* () {
          if ((window as any).failFolderRead)
            throw new Error("Folder temporarily unavailable");
          yield* (root as any).values();
        },
        getDirectoryHandle: root.getDirectoryHandle.bind(root),
        getFileHandle: root.getFileHandle.bind(root),
        queryPermission: async () => "granted",
        requestPermission: async () => "granted",
      };
    };
  });
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#mount-folder").click();
  await expect(page.locator("#project-title")).toHaveText("Mounted project");
  await expect(page.locator("#workspace-mode")).toHaveText("Folder connected");
  await expect(page.locator("#reload-folder")).toBeVisible();
  await expect(page.locator("#save-folder")).toBeDisabled();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// saved from muzpad");
  await page.locator("#save-folder").click();
  await expect(page.locator("#folder-state")).toContainText("Saved to folder");
  expect(
    await page.evaluate(async () =>
      (
        await (
          await (
            await navigator.storage.getDirectory()
          ).getFileHandle("song.muz")
        ).getFile()
      ).text(),
    ),
  ).toContain("saved from muzpad");
  await page.locator("#add-file").click();
  await page.locator("#new-file-name").fill("parts/nested/voice.muz");
  await page.locator("#create-file").click();
  await page.locator("#save-folder").click();
  await expect(page.locator("#folder-state")).toContainText("Saved to folder");
  expect(
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const nested = await (
        await root.getDirectoryHandle("parts")
      ).getDirectoryHandle("nested");
      return (await (await nested.getFileHandle("voice.muz")).getFile()).text();
    }),
  ).toContain("New musical material");
  await page.locator('[data-file="song.muz"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// local edit");
  await page.evaluate(async () => {
    const file = await (
      await navigator.storage.getDirectory()
    ).getFileHandle("song.muz");
    const writer = await file.createWritable();
    await writer.write("// edited outside");
    await writer.close();
  });
  await page.locator("#save-folder").click();
  await expect(page.locator("#diagnostic-list")).toContainText(
    "changed outside muzpad",
  );
  expect(
    await page.evaluate(async () =>
      (
        await (
          await (
            await navigator.storage.getDirectory()
          ).getFileHandle("song.muz")
        ).getFile()
      ).text(),
    ),
  ).toBe("// edited outside");
  await expect(page.locator(".cm-content")).toContainText("local edit");
  await page.evaluate(() => {
    (window as any).failFolderRead = true;
  });
  await page.locator("#reload-folder").click();
  await expect(page.locator("#diagnostic-list")).toContainText(
    "Folder temporarily unavailable",
  );
  await expect(page.locator(".cm-content")).toContainText("local edit");
  await expect(page.locator("#workspace-mode")).toHaveText("Folder connected");
  await page.evaluate(async () => {
    (window as any).failFolderRead = false;
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("song.muz");
    await root.removeEntry("parts", { recursive: true });
    for (const [path, text] of Object.entries({
      "main.muz":
        'song({tracks:[track("reloaded", phrase("C4:q"), synth("init"))],tail:0.1})',
      "muzpad.json": JSON.stringify({
        title: "Reloaded from disk",
        entry: "main.muz",
      }),
      "README.md": "# New disk document",
    })) {
      const writer = await (
        await root.getFileHandle(path, { create: true })
      ).createWritable();
      await writer.write(text);
      await writer.close();
    }
  });
  await page.locator("#reload-folder").click();
  await expect(page.locator("#project-title")).toHaveText("Reloaded from disk");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(
    page.locator('[data-kind="project"][data-file="song.muz"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-kind="project"][data-file="README.md"]'),
  ).toBeVisible();
  await expect(page.locator("#source-path")).toHaveText("main.muz");
  await expect(page.locator("#workspace-mode")).toHaveText("Folder connected");
  await expect(page.locator("#save-folder")).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("muzpad-previous-v1")!).files[
          "song.muz"
        ],
    ),
  ).toContain("local edit");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// saved after reload");
  await expect(page.locator("#folder-state")).toContainText("1 unsaved file");
  await page.locator("#save-folder").click();
  await expect(page.locator("#folder-state")).toContainText("Saved to folder");
  expect(
    await page.evaluate(async () =>
      (
        await (
          await (
            await navigator.storage.getDirectory()
          ).getFileHandle("main.muz")
        ).getFile()
      ).text(),
    ),
  ).toContain("saved after reload");
  await page.reload();
  await expect(page.locator("#workspace-mode")).toHaveText("Browser copy");
  await expect(page.locator("#folder-state")).toContainText(
    "no longer connected",
  );
  await expect(page.locator("#reload-folder")).toBeHidden();
  await expect(page.locator("#save-folder")).toBeHidden();
  await expect(page.locator("#download")).toBeVisible();
});

test("mounted folder reload rebuilds the selected entry instead of the disk default", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Requires writable directory handles");
  await page.addInitScript(() => {
    (window as any).showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      for (const [path, source] of Object.entries({
        "muzpad.json": JSON.stringify({ entry: "song.muz" }),
        "song.muz":
          'song({tracks:[track("default", phrase("C4:q"), synth("init"))],tail:0.1})',
        "audition.muz":
          'song({tracks:[track("audition", phrase("D4:q"), synth("init"))],tail:0.1})',
      })) {
        const writer = await (
          await root.getFileHandle(path, { create: true })
        ).createWritable();
        await writer.write(source);
        await writer.close();
      }
      return {
        kind: "directory",
        name: "Audition project",
        values: (root as any).values.bind(root),
        getDirectoryHandle: root.getDirectoryHandle.bind(root),
        getFileHandle: root.getFileHandle.bind(root),
        queryPermission: async () => "granted",
        requestPermission: async () => "granted",
      };
    };
  });
  await page.goto("./");
  await page.locator("#mount-folder").click();
  await expect(page.locator("#project-title")).toHaveText("Audition project");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#entry-select").selectOption("audition.muz");
  await expect(page.locator("#entry-label")).toHaveText(
    "Active entry: song.muz",
  );
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const writer = await (
      await root.getFileHandle("audition.muz")
    ).createWritable();
    await writer.write(
      'song({tracks:[track("audition_updated", phrase("E4:q"), synth("init"))],tail:0.1})',
    );
    await writer.close();
  });
  await page.locator("#reload-folder").click();
  await expect(
    page.locator("#analysis-source option[value='audition_updated']"),
  ).toHaveCount(1);
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#entry-select")).toHaveValue("audition.muz");
  await expect(page.locator("#source-path")).toHaveText("audition.muz");
  await expect(page.locator("#entry-label")).not.toContainText("song.muz");
  await expect(page.locator("#workspace-mode")).toHaveText("Folder connected");
});

test("Entrypoints excludes helper modules and refreshes after edits", async ({
  page,
}) => {
  await page.addInitScript(
    (base) =>
      localStorage.setItem(
        "muzpad-draft-v1",
        JSON.stringify({
          ...base,
          files: { ...base.files, "helper.muz": "fn double(x) = x * 2;" },
        }),
      ),
    fixture,
  );
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.getByLabel("Entrypoints")).toBeEnabled();
  await expect(
    page.locator('#entry-select option[value="production.muz"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('#entry-select option[value="helper.muz"]'),
  ).toHaveCount(0);
  await page.locator('[data-file="helper.muz"]').click();
  await expect(page.locator("#set-entry")).toBeDisabled();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(fixture.files["production.muz"]);
  await expect(
    page.locator('#entry-select option[value="helper.muz"]'),
  ).toHaveCount(1);
  await expect(page.locator("#set-entry")).toBeEnabled();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("fn double(x) = x * 2;");
  await expect(
    page.locator('#entry-select option[value="helper.muz"]'),
  ).toHaveCount(0);
  await expect(page.locator("#set-entry")).toBeDisabled();
});
