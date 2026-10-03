import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";

declare global {
  interface Window {
    __muzpadCommands: string[];
    __holdNextSafetyRead: boolean;
    __safetyReadBlocked: boolean;
    __releaseSafetyRead?: () => void;
    __exportWorkerBlocked: boolean;
    __exportWorkerTerminated: boolean;
    __releaseHeldExport?: () => void;
    __heldCompile: boolean;
    __releaseHeldCompilation?: () => void;
  }
}
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
const countWorkers = async (page: any) =>
  page.evaluate(
    () =>
      (window as any).__muzpadWorkers.filter((url: string) =>
        url.includes("render.worker"),
      ).length,
  );
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    (window as any).__muzpadWorkers = [];
    window.__muzpadCommands = [];
    const postMessage = NativeWorker.prototype.postMessage;
    NativeWorker.prototype.postMessage = function (...args: unknown[]) {
      const envelope = args[0];
      if (envelope && typeof envelope === "object" && "message" in envelope) {
        const message = envelope.message;
        if (message && typeof message === "object" && "command" in message &&
            typeof message.command === "string")
          window.__muzpadCommands.push(message.command);
      }
      return Reflect.apply(postMessage, this, args);
    };
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        (window as any).__muzpadWorkers.push(String(url));
        super(url, options);
      }
    };
  });
  await page.addInitScript((value) => {
    if (!localStorage.getItem("muzpad-draft-v1"))
      localStorage.setItem("muzpad-draft-v1", JSON.stringify(value));
  }, fixture);
});

test("Ctrl+Enter rebuilds without inserting a line", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#diff-category")).toHaveCount(0);
  expect(await page.evaluate(() => window.__muzpadCommands.filter(command => command === "diff"))).toEqual([]);
  const rendererWorkers = await countWorkers(page);
  await page.locator('[data-file="production.muz"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" ");
  await expect(page.locator("#revision")).toContainText("Edited");
  const lines = await page.locator(".cm-line").count();

  await page.keyboard.press("Control+Enter");

  await expect(page.locator("#revision")).toHaveText("Revision 2 accepted");
  expect(await countWorkers(page)).toBe(rendererWorkers);
  await expect(page.locator(".cm-line")).toHaveCount(lines);
  await page.locator("#revision-effects summary").click();
  await expect(page.locator("#diff-category")).toBeVisible();
  await expect(page.locator("#diff-page pre")).toBeVisible();
});

test("cancel keeps the accepted renderer and inspection revision", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  const rendererWorkers = await countWorkers(page);
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  expect(await countWorkers(page)).toBe(rendererWorkers);
  await page.locator('[data-file="production.muz"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" ");
  await page.locator("#run").click();
  await page.locator("#cancel").dispatchEvent("click");
  await expect(page.locator("#build-state")).toHaveText("Cancelled");
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  await page.locator('[data-view="routing"]').click();
  await expect(page.locator(".network")).toBeVisible();
});

test("folder MIDI assets survive compilation and ZIP export", async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "muzpad-assets-"));
  try {
    await mkdir(join(dir, "assets"));
    await writeFile(
      join(dir, "song.muz"),
      'song({tracks:[track("midi",midi("assets/part.mid"),synth("bell"))],tail:0})',
    );
    await writeFile(
      join(dir, "assets", "part.mid"),
      Buffer.from(
        "4d546864000000060000000101e04d54726b0000000d00903c648360803c0000ff2f00",
        "hex",
      ),
    );
    await page.goto("./");
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await page.locator("#folder-input").setInputFiles(dir);
    await expect(page.locator("#project-title")).toHaveText(
      dir.split("/").at(-1)!,
    );
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await expect(page.locator("#build-detail")).toContainText("1 tracks");
    await page.reload();
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await expect(page.locator("#project-title")).toHaveText(
      dir.split("/").at(-1)!,
    );
    const downloadEvent = page.waitForEvent("download");
    await page.locator("#download").click();
    const download = await downloadEvent;
    const archivePath = await download.path();
    expect(archivePath).toBeTruthy();
    const archive = unzipSync(new Uint8Array(await readFile(archivePath!)));
    expect(Buffer.from(archive["assets/part.mid"]).toString("hex")).toBe(
      "4d546864000000060000000101e04d54726b0000000d00903c648360803c0000ff2f00",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("static deployment: playback, rejected edits, source navigation, views, and export", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  const rendererWorkers = await countWorkers(page);
  await expect(page.locator("#build-detail")).toContainText("1 tracks");
  await page.locator("#play").click();
  await expect(page.locator("#clock")).not.toHaveText("0:00", {
    timeout: 8000,
  });
  // Break an imported source while accepted playback continues.
  await page.locator('[data-file="production.muz"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("bad_symbol();\n");
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Needs attention");
  await expect(page.locator("#diagnostic-list")).toContainText("bad_symbol");
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  expect(await countWorkers(page)).toBe(rendererWorkers);
  await page.locator("[data-diagnostic]").click();
  await expect(page.locator("#source-path")).toHaveText("production.muz");
  // Undo and recompile without losing the accepted snapshot.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Backspace");
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  expect(await countWorkers(page)).toBe(rendererWorkers);
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
  const archivePath = await download.path();
  await page.locator("#new-project").click();
  await expect(page.locator("#workflow-dialog")).toContainText("Leave this project?");
  await page.locator("#workflow-dialog").getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.locator("#project-title")).toHaveText("Untitled project");
  await page.locator("#zip-input").setInputFiles(archivePath!);
  await expect(page.locator("#project-title")).toHaveText(fixture.title);
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#build-detail")).toContainText("1 tracks");
  expect(errors).toEqual([]);
});

test("new project, local draft recovery, and Settings theme persistence", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator("#theme-toggle").click();
  await page.locator("#settings-theme").selectOption("dark");
  await page.locator("#settings-close").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#new-project").click();
  await expect(page.locator("#project-title")).toHaveText("Untitled project");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#build-detail")).toContainText("1 tracks");
  await page.reload();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#project-title")).toHaveText("Untitled project");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#theme-toggle").click();
  await page.locator("#settings-theme").selectOption("light");
  await page.locator("#settings-close").click();
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
  await page.locator("#zoom").fill("4");
  await page.locator("#zoom").dispatchEvent("input");
  await viewport.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await expect(viewport).toHaveAttribute("data-inspection-state", "detail");
  await canvas.click({
    position: { x: 135, y: 70 },
  });
  await expect(page.locator("#selection-label")).toContainText("C4");
});

test("Markdown renders safely with local navigation", async ({ page }) => {
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
  await page.locator('[data-file="README.md"][data-kind="project"]').click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#format")).toBeDisabled();
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
  await expect.poll(() => doc.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
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
      { timeout: 8000 },
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
  await expect(page.locator("#workflow-dialog")).toContainText("External change: song.muz");
  await expect(page.locator("#conflict-merge")).toHaveValue(/local edit/);
  await page.locator("#workflow-dialog").getByRole("button", { name: "Keep local", exact: true }).click();
  await expect(page.locator("#workflow-dialog")).toBeHidden();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("muzpad-draft-v1")!).files["song.muz"])).toContain("local edit");
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
  await expect(page.locator("#workspace-mode")).toHaveAttribute("data-mode", "connected");
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
  await expect(page.locator("#workflow-dialog")).toContainText("External change: song.muz");
  await expect(page.locator("#conflict-merge")).toHaveValue(/local edit/);
  await page.locator("#workflow-dialog").getByRole("button", { name: "Use disk", exact: true }).click();
  await expect(page.locator("#project-title")).toHaveText("Reloaded from disk");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(
    page.locator('[data-kind="project"][data-file="song.muz"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-kind="project"][data-file="README.md"]'),
  ).toBeVisible();
  await page.locator('[data-file="main.muz"]').click();
  await expect(page.locator("#source-path")).toHaveText("main.muz");
  await expect(page.locator("#workspace-mode")).toHaveText("Folder connected");
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
  await expect(page.locator("#reload-folder")).toBeHidden();
  await expect(page.locator("#save-folder")).toBeHidden();
  await expect(page.locator("#download")).toBeVisible();
});

test("mounted folder reload preserves the selected entry and active playback", async ({
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
          'song({tracks:[track("default", phrase("C4:q").repeat(128), synth("init"))],tail:0.1})',
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
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#mount-folder").click();
  await expect(page.locator("#project-title")).toHaveText("Audition project");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator(".range-menu > summary").click();
  await page.locator("#loop-start").fill("0");
  await page.locator("#loop-end").fill("64");
  await page.locator("#apply-loop").click();
  await page.locator(".range-menu > summary").click();
  await page.locator("#play").click();
  const seconds = async () => {
    const [minutes, seconds] = (await page.locator("#clock").innerText())
      .split(":")
      .map(Number);
    return minutes * 60 + seconds;
  };
  await expect.poll(seconds).toBeGreaterThanOrEqual(2);
  await page.locator("#entry-select").selectOption("audition.muz");
  await expect(page.locator("#entry-label")).toHaveText(
    "Active entry: song.muz",
  );
  await page.locator('[data-kind="project"][data-file="song.muz"]').click();
  await page.locator("#zoom-in").click();
  const zoom = await page.locator("#zoom").inputValue();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const writer = await (
      await root.getFileHandle("audition.muz")
    ).createWritable();
    await writer.write(
      'song({tracks:[track("audition_updated", phrase("E4:q").repeat(128), synth("init"))],tail:0.1})',
    );
    await writer.close();
  });
  // Gate the actual compile request, not a WASM fetch: rebuilds reuse the live engine.
  await page.evaluate(() => {
    const postMessage = Worker.prototype.postMessage;
    let hold = true;
    Worker.prototype.postMessage = function (...args: unknown[]) {
      const envelope = args[0];
      if (hold && envelope && typeof envelope === "object" && "message" in envelope) {
        const message = envelope.message;
        if (message && typeof message === "object" && "command" in message && message.command === "compile") {
          hold = false;
          window.__heldCompile = true;
          window.__releaseHeldCompilation = () => { Reflect.apply(postMessage, this, args); };
          return;
        }
      }
      return Reflect.apply(postMessage, this, args);
    };
  });
  const beforeReload = await seconds();
  try {
    await page.locator("#reload-folder").click();
    await expect(page.locator("#build-state")).toHaveText("Compiling");
    await expect.poll(() => page.evaluate(() => window.__heldCompile)).toBe(true);
    await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
    await expect(page.locator("#play")).toBeEnabled();
    await expect(page.locator("#loop")).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator("#analysis-source option[value='default']"),
    ).toHaveCount(1);
    await expect.poll(seconds).toBeGreaterThan(beforeReload);
  } finally {
    await page.evaluate(() => window.__releaseHeldCompilation?.());
  }
  await expect(
    page.locator("#analysis-source option[value='audition_updated']"),
  ).toHaveCount(1);
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#entry-select")).toHaveValue("audition.muz");
  await expect(page.locator("#source-path")).toHaveText("song.muz");
  await expect(page.locator('[data-tab="project:audition.muz"]')).toBeVisible();
  await expect(page.locator("#zoom")).toHaveValue(zoom);
  await expect(page.locator("#entry-label")).not.toContainText("song.muz");
  await expect(page.locator("#workspace-mode")).toHaveText("Folder connected");
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  await expect(page.locator("#loop")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(seconds).toBeGreaterThan(beforeReload);

  // A rejected disk edit keeps the accepted arrangement and audio running.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const writer = await (
      await root.getFileHandle("audition.muz")
    ).createWritable();
    await writer.write("bad_symbol();");
    await writer.close();
  });
  await page.locator("#reload-folder").click();
  await expect(page.locator("#build-state")).toHaveText("Needs attention");
  await expect(page.locator("#diagnostic-list")).toContainText("bad_symbol");
  await expect(
    page.locator("#analysis-source option[value='audition_updated']"),
  ).toHaveCount(1);
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  const afterFailure = await seconds();
  await expect.poll(seconds).toBeGreaterThan(afterFailure);

  // Reload also respects a paused transport rather than starting it.
  await page.locator("#play").click();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const writer = await (
      await root.getFileHandle("audition.muz")
    ).createWritable();
    await writer.write(
      'song({tracks:[track("recovered", phrase("F4:q").repeat(128), synth("init"))],tail:0.1})',
    );
    await writer.close();
  });
  await page.locator("#reload-folder").click();
  await expect(
    page.locator("#analysis-source option[value='recovered']"),
  ).toHaveCount(1);
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#play")).toHaveText("▶ Play");
  await expect.poll(seconds).toBeGreaterThanOrEqual(afterFailure);
  // A clean selected file removed on disk uses the same right-neighbor rule.
  await page.locator('[data-tab="project:song.muz"]').click();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("song.muz");
  });
  await page.locator("#reload-folder").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator('[data-tab="project:song.muz"]')).toHaveCount(0);
  await expect(page.locator('[data-tab="project:audition.muz"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-content")).toContainText('track("recovered"');
  await page.locator('[data-close-tab="project:audition.muz"]').click();
  await expect(page.locator("#source-empty")).toBeVisible();
  await page.locator("#reload-folder").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("[data-tab]")).toHaveCount(0);
  await expect(page.locator("#source-empty")).toBeVisible();
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

test("closing views uses ordered neighbors and retains canonical edits and undo", async ({ page }) => {
  await page.addInitScript((base) => {
    if (JSON.parse(localStorage.getItem("muzpad-draft-v1") ?? "null")?.id === "closed-history") return;
    localStorage.setItem("muzpad-draft-v1", JSON.stringify({
      ...base, id: "closed-history",
      files: {
        ...base.files,
        "parts/song.muz": '// Duplicate basename\nlet part = 1;',
        "README.md": "# View retention\n\n[Open part](parts/song.muz)",
      },
    }));
  }, fixture);
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator('[data-file="production.muz"]').click();
  await page.locator('[data-folder="project:parts"] > summary').click();
  await page.locator('[data-file="parts/song.muz"]').click();
  await page.locator('[data-kind="project"][data-file="README.md"]').click();
  const keys = () => page.locator("[data-tab]").evaluateAll(elements =>
    elements.map(element => element.getAttribute("data-tab")));
  const order = ["project:song.muz", "project:production.muz", "project:parts/song.muz", "project:README.md"];
  expect(await keys()).toEqual(order);
  await page.locator('[data-tab="project:production.muz"]').click();
  expect(await keys()).toEqual(order);
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// retained closed edit");
  await page.keyboard.press("Shift+Home");
  const selection = await page.evaluate(() => getSelection()?.toString());
  expect(selection).toBe("// retained closed edit");
  await page.locator('[data-close-tab="project:production.muz"]').click();
  await expect(page.locator('[data-tab="project:parts/song.muz"]')).toHaveAttribute("aria-selected", "true");
  await page.locator('[data-file="production.muz"]').click();
  expect(await keys()).toEqual([order[0], order[2], order[3], order[1]]);
  await expect(page.locator(".cm-content")).toContainText("// retained closed edit");
  await page.locator(".cm-content").focus();
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(selection);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".cm-content")).not.toContainText("// retained closed edit");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.locator(".cm-content")).toContainText("// retained closed edit");
  await page.locator('[data-tab="project:song.muz"]').click();
  await page.locator('[data-close-tab="project:production.muz"]').click();
  await expect(page.locator('[data-tab="project:song.muz"]')).toHaveAttribute("aria-selected", "true");
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  const archive = unzipSync(new Uint8Array(await readFile((await (await downloadEvent).path())!)));
  expect(new TextDecoder().decode(archive["production.muz"])).toContain("// retained closed edit");
  await page.locator('[data-tab="project:README.md"]').click();
  await page.locator('[data-close-tab="project:README.md"]').click();
  await expect(page.locator('[data-tab="project:parts/song.muz"]')).toHaveAttribute("aria-selected", "true");
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.reload();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator('[data-file="production.muz"]').click();
  await expect(page.locator(".cm-content")).toContainText("// retained closed edit");
});

test("last close leaves transport, nondefault entry, loop and audition alive without compiling", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#entry-select").selectOption("production.muz");
  await page.locator("#run").click();
  await expect(page.locator("#entry-label")).toHaveText("Entry: production.muz");
  await page.locator("#loop").click();
  await page.getByRole("button", { name: "Mute lead", exact: true }).click();
  await page.locator("#analysis-source").selectOption("lead");
  await page.locator("#play").click();
  await expect(page.locator("#clock")).not.toHaveText("0:00", { timeout: 8000 });
  const revision = await page.locator("#revision").textContent();
  const renderers = await countWorkers(page);
  const operations = () => page.evaluate(() => window.__muzpadCommands.filter(command =>
    ["compile", "check_entry", "accept_compilation", "reset"].includes(command)));
  // Entry discovery must have completed before observing close-only operations.
  await expect(page.locator("#entry-select")).toBeEnabled();
  const before = await operations();
  while (await page.locator("[data-close-tab]").count())
    await page.locator("[data-close-tab]").last().click();
  await expect(page.locator("#source-empty")).toContainText("No file open");
  await expect(page.locator("#open-entrypoint")).toBeFocused();
  await expect(page.locator("#format")).toBeDisabled();
  await expect(page.locator("#set-entry")).toBeDisabled();
  await expect(page.locator("#entry-select")).toBeEnabled();
  await expect(page.locator("#run")).toBeEnabled();
  await expect(page.locator("#loop")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Mute lead", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#analysis-source")).toHaveValue("lead");
  await expect(page.locator("#revision")).toHaveText(revision!);
  const clock = await page.locator("#clock").textContent();
  await expect(page.locator("#clock")).not.toHaveText(clock!);
  expect(await operations()).toEqual(before);
  expect(await countWorkers(page)).toBe(renderers);
  await page.locator("#play").click();
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#source-empty")).toBeVisible();
  await page.locator("#open-entrypoint").click();
  await expect(page.locator("#source-path")).toHaveText("production.muz");
});

test("tab keyboard navigation and library close/reopen preserve read-only identity", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator('[data-file="production.muz"]').click();
  await page.locator('[data-core-folder="contrib"] > summary').click();
  await page.locator('[data-folder="library:contrib/unreal"] > summary').click();
  await page.locator('[data-folder="library:contrib/unreal/metal-gtx"] > summary').click();
  const path = "contrib/unreal/metal-gtx/metal-gtx.muz";
  await page.locator(`[data-file="${path}"]`).click();
  const tab = page.locator(`[data-tab="library:${path}"]`);
  const close = page.locator(`[data-close-tab="library:${path}"]`);
  await expect(close).toHaveAccessibleName(new RegExp(`library.*${path.replaceAll(".", "\\.")}`, "i"));
  expect(await close.evaluate(element => element.parentElement?.closest("button"))).toBeNull();
  await tab.focus();
  await page.keyboard.press("Home");
  await expect(page.locator('[data-tab="project:song.muz"]')).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('[data-tab="project:production.muz"]')).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(tab).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(tab).toHaveCount(0);
  await expect(page.locator('[data-tab="project:production.muz"]')).toBeFocused();
  await page.locator(`[data-file="${path}"]`).click();
  await expect(page.locator("#format")).toBeDisabled();
  await expect(page.locator("#set-entry")).toBeDisabled();
  const text = await page.locator(".cm-content").textContent();
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("forbidden");
  await expect(page.locator(".cm-content")).toHaveText(text!);
  await close.focus();
  await page.keyboard.press("Space");
  await expect(tab).toHaveCount(0);
});

test("Markdown details and scroll survive close while explicit anchors override retention", async ({ page }) => {
  await page.addInitScript((base) => {
    localStorage.setItem("muzpad-draft-v1", JSON.stringify({
      ...base, files: {
        ...base.files,
        "README.md": `# Guide\n\n<details><summary>Details</summary>Retained contents</details>\n\n${"Paragraph.\n\n".repeat(100)}## Destination\n\nEnd.`,
        "links.md": "[Destination](README.md#destination)",
      },
    }));
  }, fixture);
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator('[data-kind="project"][data-file="README.md"]').click();
  await page.locator("#document summary").click();
  await page.locator("#document").evaluate(element => { element.scrollTop = 300; });
  const scroll = await page.locator("#document").evaluate(element => element.scrollTop);
  await page.locator('[data-close-tab="project:README.md"]').click();
  await page.locator('[data-kind="project"][data-file="README.md"]').click();
  await expect(page.locator("#document details")).toHaveAttribute("open", "");
  await expect.poll(() => page.locator("#document").evaluate(element => element.scrollTop)).toBeCloseTo(scroll, 0);
  await page.locator('[data-file="links.md"]').click();
  await page.locator("#document").getByRole("link", { name: "Destination" }).click();
  await expect.poll(() => page.locator("#document").evaluate(element => element.scrollTop)).toBeGreaterThan(scroll + 200);
});

test("editor scroll survives source/document switches and cancelled replacement retains views", async ({ page }) => {
  await page.addInitScript(base => {
    localStorage.setItem("muzpad-draft-v1", JSON.stringify({
      ...base, files: {
        ...base.files,
        "production.muz": `${base.files["production.muz"]}\n${"// retained scroll line\n".repeat(120)}`,
        "README.md": "# Editor checkpoint",
      },
    }));
  }, fixture);
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator('[data-file="production.muz"]').click();
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("// unsaved final line");
  await page.keyboard.press("Shift+Home");
  const selected = await page.evaluate(() => getSelection()?.toString());
  const scroll = await page.locator(".cm-scroller").evaluate(element => element.scrollTop);
  expect(scroll).toBeGreaterThan(300);
  await page.locator('[data-kind="project"][data-file="README.md"]').click();
  await page.locator('[data-tab="project:production.muz"]').click();
  await expect.poll(() => page.locator(".cm-scroller").evaluate(element => element.scrollTop)).toBeCloseTo(scroll, 0);
  await page.locator(".cm-content").evaluate((element: HTMLElement) => element.focus({ preventScroll: true }));
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(selected);
  await page.locator('[data-close-tab="project:production.muz"]').click();
  await page.locator('[data-file="production.muz"]').click();
  await expect.poll(() => page.locator(".cm-scroller").evaluate(element => element.scrollTop)).toBeCloseTo(scroll, 0);
  const tabs = await page.locator("[data-tab]").evaluateAll(elements => elements.map(element => element.getAttribute("data-tab")));
  await page.locator("#new-project").click();
  await expect(page.locator("#workflow-dialog")).toBeVisible();
  await page.locator("#workflow-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#project-title")).toHaveText("Browser project");
  expect(await page.locator("[data-tab]").evaluateAll(elements => elements.map(element => element.getAttribute("data-tab")))).toEqual(tabs);
  await expect(page.locator("#source-path")).toHaveText("production.muz");
  await page.locator(".cm-content").evaluate((element: HTMLElement) => element.focus({ preventScroll: true }));
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".cm-content")).not.toContainText("// unsaved final line");
});

test("a real asynchronous Format reply cannot edit the next tab or a detached source", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator('[data-file="production.muz"]').click();
  const source = await page.locator(".cm-content").textContent();
  const formats = await page.evaluate(() => window.__muzpadCommands.filter(command => command === "format").length);
  // Both real UI actions occur in the same task, before a worker can deliver its reply.
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("#format")!.click();
    document.querySelector<HTMLButtonElement>('[data-close-tab="project:production.muz"]')!.click();
  });
  await expect(page.locator("#source-path")).toHaveText("song.muz");
  await expect(page.locator(".cm-content")).toHaveText(fixture.files["song.muz"]);
  await expect(page.locator("#format")).toBeEnabled();
  expect(await page.evaluate(() => window.__muzpadCommands.filter(command => command === "format").length)).toBe(formats + 1);
  await page.locator('[data-close-tab="project:song.muz"]').click();
  await expect(page.locator("#source-empty")).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  const archive = unzipSync(new Uint8Array(await readFile((await (await downloadEvent).path())!)));
  expect(Object.keys(archive).sort()).toEqual(["muzpad.json", "production.muz", "song.muz"]);
  expect(new TextDecoder().decode(archive["song.muz"])).toBe(fixture.files["song.muz"]);
  expect(new TextDecoder().decode(archive["production.muz"])).toBe(fixture.files["production.muz"]);
  await page.locator("#open-entrypoint").click();
  await page.locator('[data-file="production.muz"]').click();
  await expect(page.locator(".cm-content")).toHaveText(source!);
});

test("pending Format cannot carry text or undo history into a replacement with the same path", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("#format")!.click();
    document.querySelector<HTMLButtonElement>("#new-project")!.click();
  });
  await expect(page.locator("#project-title")).toHaveText("Untitled project");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#source-path")).toHaveText("song.muz");
  await expect(page.locator(".cm-content")).toContainText("Untitled project");
  await expect(page.locator(".cm-content")).not.toContainText('use "production.muz"');
  const replacement = await page.locator(".cm-content").textContent();
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".cm-content")).toHaveText(replacement!);
});

async function mountSafetyFolder(page: Page) {
  await page.addInitScript(() => {
    let mounted: Promise<FileSystemDirectoryHandle> | undefined;
    const setup = async () => {
      const root = await navigator.storage.getDirectory();
      for (const [path, text] of Object.entries({
        "muzpad.json": JSON.stringify({ title: "Safety folder", entry: "song.muz", entries: ["song.muz"] }),
        "song.muz": 'song({tracks:[track("tone",phrase("C4:q E4:q"),synth("init"))],tail:0})',
        "a.muz": "// initial A\n",
        "b.muz": "// initial B\n",
      })) {
        const writer = await (await root.getFileHandle(path, { create: true })).createWritable();
        await writer.write(text);
        await writer.close();
      }
      return root;
    };
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => {
      const root = await (mounted ??= setup());
      // Chromium implements async directory iteration omitted by some DOM typings.
      const iterable = root as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> };
      return {
        kind: "directory", name: "Safety folder",
        values: async function* () {
          if (window.__holdNextSafetyRead) {
            window.__holdNextSafetyRead = false;
            window.__safetyReadBlocked = true;
            await new Promise<void>(resolve => { window.__releaseSafetyRead = resolve; });
            window.__safetyReadBlocked = false;
          }
          yield* iterable.values();
        },
        getFileHandle: root.getFileHandle.bind(root),
        getDirectoryHandle: root.getDirectoryHandle.bind(root),
        queryPermission: async () => "granted",
        requestPermission: async () => "granted",
      };
    } });
  });
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#mount-folder").click();
  await expect(page.locator("#project-title")).toHaveText("Safety folder");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
}

test("a conflict in B cannot overwrite an equal-version edit raced against A's disk refresh", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Uses real writable browser folder handles");
  await mountSafetyFolder(page);
  await page.locator('[data-file="b.muz"]').click();
  await page.locator(".cm-content").press("ControlOrMeta+End");
  await page.keyboard.insertText("// local B\n");
  await page.locator('[data-file="a.muz"]').click();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const [path, text] of [["a.muz", "// disk A\n"], ["b.muz", "// disk B\n"]]) {
      const writer = await (await root.getFileHandle(path)).createWritable();
      await writer.write(text);
      await writer.close();
    }
    window.__holdNextSafetyRead = true;
  });
  await page.locator("#reload-folder").click();
  await expect.poll(() => page.evaluate(() => window.__safetyReadBlocked)).toBe(true);
  await page.locator(".cm-content").press("ControlOrMeta+End");
  await page.keyboard.insertText("// raced local A\n");
  await page.evaluate(() => window.__releaseSafetyRead?.());
  await expect(page.locator("#workflow-dialog")).toContainText("External change: b.muz");
  await expect(page.locator(".cm-content")).toContainText("raced local A");
  await expect(page.locator(".cm-content")).not.toContainText("disk A");
  await page.locator("#workflow-dialog").getByRole("button", { name: "Use disk", exact: true }).click();
  // Recapturing the raced buffer must produce its own explicit conflict, not
  // silently adopt the newly observed baseline and authorize an overwrite.
  await expect(page.locator("#workflow-dialog")).toContainText("External change: a.muz");
  await expect(page.locator("#conflict-merge")).toHaveValue(/raced local A/);
  await page.locator("#workflow-dialog").getByRole("button", { name: "Keep local", exact: true }).click();
  await expect(page.locator("#workflow-dialog")).toBeHidden();
  await page.locator('[data-file="b.muz"]').click();
  await expect(page.locator(".cm-content")).toHaveText("// disk B");
  await page.locator('[data-file="a.muz"]').click();
  await expect(page.locator(".cm-content")).toContainText("raced local A");
  expect(await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle("a.muz")).getFile()).text())).toBe("// disk A\n");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("muzpad-draft-v1")!).files["a.muz"])).toContain("raced local A");
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  const archive = unzipSync(await readFile((await (await downloadEvent).path())!));
  expect(new TextDecoder().decode(archive["a.muz"])).toContain("raced local A");
  expect(new TextDecoder().decode(archive["b.muz"])).toBe("// disk B\n");
  await page.locator("#save-folder").click();
  await expect(page.locator("#folder-state")).toContainText("Saved to folder");
  expect(await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle("a.muz")).getFile()).text())).toContain("raced local A");
});

test("recreating a deleted source reuses its canonical tombstone for save rebuild recovery and ZIP", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Uses real writable browser folder handles");
  await mountSafetyFolder(page);
  await page.locator('[data-file="a.muz"]').click();
  await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry("a.muz"));
  await page.locator("#reload-folder").click();
  await expect(page.locator('[data-file="a.muz"]')).toHaveCount(0);
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#add-file").click();
  await page.locator("#new-file-name").fill("a.muz");
  await page.locator("#create-file").click();
  await page.locator(".cm-content").press("ControlOrMeta+End");
  await page.keyboard.insertText("// recreated canonical A\n");
  await page.locator("#save-folder").click();
  await expect(page.locator("#folder-state")).toContainText("Saved to folder");
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("muzpad-draft-v1")!).files["a.muz"])).toContain("recreated canonical A");
  expect(await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle("a.muz")).getFile()).text())).toContain("recreated canonical A");
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  const archive = unzipSync(await readFile((await (await downloadEvent).path())!));
  expect(new TextDecoder().decode(archive["a.muz"])).toContain("recreated canonical A");
  expect(Object.keys(archive).filter(path => path === "a.muz")).toHaveLength(1);
  await expect(page.locator("#diagnostic-list")).not.toContainText(/unique.*paths|duplicate|stale_request/i);
});

test("a clean browser project offers explicit active-export cancellation before replacement", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Uses a saved folder to establish an unambiguously clean project");
  await page.addInitScript(() => {
    const send = Worker.prototype.postMessage;
    const terminate = Worker.prototype.terminate;
    let exportWorker: Worker | undefined;
    let cancelled = false;
    Worker.prototype.postMessage = function (...args: unknown[]) {
      const payload = args[0];
      if (payload && typeof payload === "object" && "format" in payload && "snapshot" in payload) {
        // Pause the real worker's request boundary after the runtime registered
        // its actual job. No result/progress/cancellation response is substituted.
        exportWorker = this;
        window.__exportWorkerBlocked = true;
        void new Promise<void>(resolve => { window.__releaseHeldExport = resolve; }).then(() => {
          if (!cancelled) Reflect.apply(send, this, args);
        });
        return;
      }
      Reflect.apply(send, this, args);
    };
    Worker.prototype.terminate = function () {
      if (this === exportWorker) {
        cancelled = true;
        window.__exportWorkerTerminated = true;
      }
      Reflect.apply(terminate, this, []);
    };
  });
  await mountSafetyFolder(page);
  let downloads = 0;
  page.on("download", () => { downloads++; });
  await page.locator("#export-media").click();
  await page.locator("#export-master").click();
  await expect.poll(() => page.evaluate(() => window.__exportWorkerBlocked)).toBe(true);
  // Exercise the production replacement action while the export modal is open,
  // as a shell close request can arrive independently of modal pointer focus.
  await page.locator("#new-project").dispatchEvent("click");
  await expect(page.locator("#workflow-dialog")).toContainText("Exports are still active");
  await page.locator("#workflow-dialog").getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(page.locator("#project-title")).toHaveText("Safety folder");
  await expect(page.locator(".export-dialog")).toBeVisible();
  expect(await page.evaluate(() => window.__exportWorkerTerminated)).not.toBe(true);
  await page.locator("#new-project").dispatchEvent("click");
  await expect(page.locator("#workflow-dialog")).toContainText("Exports are still active");
  await page.locator("#workflow-dialog").getByRole("button", { name: "Cancel exports and close", exact: true }).click();
  await expect(page.locator("#project-title")).toHaveText("Untitled project");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect.poll(() => page.evaluate(() => window.__exportWorkerTerminated)).toBe(true);
  await page.evaluate(() => window.__releaseHeldExport?.());
  expect(downloads).toBe(0);
});

test("source creation accepts Unicode and spaces without accepting project path escapes", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  const projectPaths = () => page.locator('[data-kind="project"][data-file]').evaluateAll(elements =>
    elements.map(element => (element as HTMLElement).dataset.file));
  const before = await projectPaths();
  await page.locator("#add-file").click();
  for (const path of ["../escape.muz", "/absolute.muz", "nested\\escape.muz", "nested/\0escape.muz",
    "nested/.muzpad-private/escape.muz"]) {
    await page.locator("#new-file-name").evaluate((element: HTMLInputElement, value) => { element.value = value; }, path);
    await page.locator("#create-file").click();
    await expect(page.locator("#file-dialog")).toBeVisible();
    expect(await projectPaths()).toEqual(before);
  }
  const path = "nested Ω/new source.muz";
  await page.locator("#new-file-name").fill(path);
  await page.locator("#create-file").click();
  await expect(page.locator("#file-dialog")).toBeHidden();
  await expect(page.locator("#source-path")).toHaveText(path);
  expect(await projectPaths()).toContain(path);
  const downloading = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await downloading;
  const archivePath = await download.path();
  const archive = unzipSync(new Uint8Array(await readFile(archivePath!)));
  expect(Object.hasOwn(archive, path)).toBe(true);
  expect(archive[path].byteLength).toBeGreaterThan(0);
});
