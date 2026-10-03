import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const fixture = {
  id: "export-test",
  title: "Export test",
  entry: "song.muz",
  files: {
    "song.muz":
      'song({tempo:120, tracks:[track("lead",phrase("C4:q E4:q"),synth("init")),track("bass",phrase("C3:h"),synth("init"))],tail:0.1})',
  },
};
test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    (value) => localStorage.setItem("muzpad-draft-v1", JSON.stringify(value)),
    fixture,
  );
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#export-media").click();
});
async function download(page: any, selector: string) {
  const pending = page.waitForEvent("download");
  await page.locator(selector).click();
  const result = await pending;
  return {
    bytes: await readFile((await result.path())!),
  };
}
test("master and custom WAV downloads, MIDI track selection and playback retained", async ({
  page,
}) => {
  const master = await download(page, "#export-master");
  expect(master.bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(master.bytes.readUInt32LE(24)).toBe(48000);
  expect(master.bytes.readUInt16LE(34)).toBe(24);
  expect(master.bytes.length).toBe(44 + 52800 * 6);
  await page.locator("#export-none").click();
  await page.locator('input[name="export-track"]').last().check();
  await page.locator("#export-rate").selectOption("44100");
  await page.locator("#export-bits").selectOption("16");
  await page.locator("#export-start").fill("0.25");
  await page.locator("#export-end").fill("0.5");
  const wav = await download(page, "#export-submit");
  expect(wav.bytes.length).toBe(44 + 11025 * 4);
  await page.locator("#export-format").selectOption("midi");
  const midi = await download(page, "#export-submit");
  expect(midi.bytes.toString("ascii", 0, 4)).toBe("MThd");
  expect(midi.bytes.readUInt16BE(10)).toBe(2);
  expect(midi.bytes.includes(Buffer.from("bass"))).toBeTruthy();
  expect(midi.bytes.includes(Buffer.from("lead"))).toBeFalsy();
  await page.locator("#export-all").click();
  const multi = await download(page, "#export-submit");
  expect(multi.bytes.readUInt16BE(10)).toBe(3);
  await page.locator("#export-close").click();
  await page.locator("#play").click();
  await expect(page.locator("#play")).toContainText("Pause");
});
test("validation and cancellation allow retry", async ({ page }) => {
  await page.locator("#export-none").click();
  await page.locator("#export-submit").click();
  await expect(page.locator("#export-status")).toHaveText(
    "Select at least one track.",
  );
  await page.locator("#export-all").click();
  await page.locator("#export-end").fill("100");
  await page.locator("#export-submit").click();
  await expect(page.locator("#export-status")).toContainText("Choose a range");
  await page.evaluate(() => {
    document.getElementById("export-master")!.click();
    document.getElementById("export-cancel")!.click();
  });
  await expect(page.locator("#export-status")).toHaveText("Export cancelled.");
  await expect(page.locator("#export-master")).toBeEnabled();
  // A failed worker can also be retried.
  await page.route("**/muz.wasm", (route) => route.abort());
  await page.locator("#export-master").click();
  await expect(page.locator("#export-status")).toContainText("Export failed");
  await page.unroute("**/muz.wasm");
  await page.locator("#export-format").selectOption("midi");
  await download(page, "#export-submit");
});

test("edited source exports the accepted revision until rebuilt", async ({
  page,
}) => {
  await page.locator("#export-close").click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" ");
  await expect(page.locator("#revision")).toContainText("Edited");
  await page.locator("#export-media").click();
  await expect(page.locator(".export-dialog")).toContainText(
    "Rebuild first to include your latest edits",
  );
  await page.locator("#export-format").selectOption("midi");
  const result = await download(page, "#export-submit");
  expect(result.bytes.readUInt16BE(10)).toBe(3);
});
