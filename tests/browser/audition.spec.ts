import { test, expect } from "@playwright/test";

declare global { interface Window { renderWorkers: number } }

test("track and kit M/S controls preserve playback and survive rebuilds", async ({
  page,
}) => {
  const source = `song({tracks:[track("kit",drums({kick:"x...",snare:"..x."}).repeat(128),kit("dry")),track("kit.lead",note(60,512b),synth("init"))],tail:0})`;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((source) => {
    localStorage.setItem(
      "muzpad-draft-v1",
      JSON.stringify({
        id: "audition",
        title: "Audition",
        entry: "song.muz",
        files: { "song.muz": source },
      }),
    );
    window.renderWorkers = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (String(url).includes("render.worker"))
          window.renderWorkers++;
        super(url, options);
      }
    };
  }, source);
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#play").click();
  const group = page.getByRole("button", { name: "Mute kit kit", exact: true });
  const originalButton = await group.elementHandle();
  await page.locator("#arrangement").dispatchEvent("scroll");
  await expect(page.locator("#arrangement")).toHaveAttribute(
    "data-inspection-state",
    "ready",
  );
  expect(await originalButton!.evaluate((button) => button.isConnected)).toBe(
    true,
  );
  await group.click();
  await expect(group).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Mute kit.kick", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Mute kit.lead", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page
    .getByRole("button", { name: "Mute kit.kick", exact: true })
    .click();
  await expect(group).toHaveAttribute("aria-pressed", "mixed");
  await page
    .getByRole("button", { name: "Solo kit.kick", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Solo kit.lead", exact: true })
    .click();
  await page
    .locator("#arrangement")
    .screenshot({ path: "test-results/audition-controls.png" });
  await page
    .getByRole("button", { name: "Collapse kit kit", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Solo kit kit", exact: true }),
  ).toHaveAttribute("aria-pressed", "mixed");
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  await expect(page.locator("#revision")).toHaveText("Revision 1 accepted");
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(
    source.replace('synth("init")', 'synth("bell")'),
  );
  await page.locator("#run").click();
  await expect(page.locator("#revision")).toHaveText("Revision 2 accepted");
  await expect(group).toHaveAttribute("aria-pressed", "mixed");
  await expect(
    page.getByRole("button", { name: "Solo kit.lead", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  expect(await page.evaluate(() => window.renderWorkers)).toBe(1);
  expect(errors).toEqual([]);
});
