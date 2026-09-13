import { test, expect } from "@playwright/test";
const id = "a".repeat(32);
const gist = {
  description: "Gist piece",
  files: {
    "song.muz": { content: 'use "parts/main.muz" as p; p.main' },
    "part.muz": {
      content:
        'use "std/synthesis" as s; let main = song({title: "Gist piece", tempo: 120, tracks: [track("lead", phrase("C4:q E4:q"), s.pluck())], tail: 0.1});',
    },
    "muzpad.json": {
      content: JSON.stringify({
        title: "Gist piece",
        entry: "song.muz",
        paths: { "part.muz": "parts/main.muz" },
      }),
    },
  },
};
test("URL gist overrides a different draft, renders and links source, then recovers local edits", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("muzpad-draft-v1"))
      localStorage.setItem(
        "muzpad-draft-v1",
        JSON.stringify({
          id: "older",
          title: "Older draft",
          entry: "song.muz",
          files: { "song.muz": "// earlier work" },
        }),
      );
  });
  let requests = 0;
  await page.route(`https://api.github.com/gists/${id}`, (route) => {
    requests++;
    return route.fulfill({ json: gist });
  });
  await page.goto(`./?gist=${id}`);
  await expect(page.locator("#project-title")).toHaveText("Gist piece");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#view-gist")).toHaveAttribute(
    "href",
    `https://gist.github.com/${id}`,
  );
  await expect(page.locator("#view-gist")).toBeVisible();
  await expect(page.locator("#download")).toBeHidden();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("// local edit\n");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("muzpad-draft-v1")))
    .toContain("local edit");
  await page.reload();
  await expect(page.locator(".cm-content")).toContainText("local edit");
  expect(requests).toBe(1);
  await page.locator("#new-project").click();
  await expect(page).not.toHaveURL(/gist=/);
  await expect(page.locator("#download")).toBeVisible();
  await expect(page.locator("#view-gist")).toBeHidden();
  await page.getByRole("button", { name: "Previous workspace" }).click();
  await expect(page).toHaveURL(new RegExp(`gist=${id}`));
  await expect(page.locator(".cm-content")).toContainText("local edit");
});
test("gist import errors preserve work; sidebar links open gists and show the active piece", async ({
  page,
}) => {
  await page.route("**/catalog.json", async (route) => {
    const data = await (await route.fetch()).json();
    data.gists = [{ gist: id, title: "Gist piece" }];
    data.engine = {
      commit: "b".repeat(40),
      sourceArchive: `https://ml.plausiblyreliable.com/muz-core/${"b".repeat(40)}.tgz`,
    };
    await route.fulfill({ json: data });
  });
  await page.route("https://api.github.com/gists/*", (route) =>
    route.fulfill({ status: 404, body: "{}" }),
  );
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#import-gist").click();
  await page.locator("#gist-input").fill(id);
  await page.locator("#gist-submit").click();
  await expect(page.locator("#gist-error")).toContainText("not found");
  await expect(page.locator("#project-title")).toHaveText("Untitled project");
  await expect(page).not.toHaveURL(/gist=/);
  await page.locator("#gist-cancel").click();
  await page.unroute("https://api.github.com/gists/*");
  await page.route(`https://api.github.com/gists/${id}`, (route) =>
    route.fulfill({ json: gist }),
  );
  await page.locator("[data-gist]").click();
  await expect(page.locator("[data-gist]")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator("[data-gist]")).toContainText("Open");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator(".source-archive")).toHaveAttribute(
    "href",
    new RegExp("/muz-core/b+\\.tgz$"),
  );
});

test("canceling an in-flight import keeps the current workspace", async ({
  page,
}) => {
  let release: () => void = () => {};
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`https://api.github.com/gists/${id}`, async (route) => {
    await paused;
    await route.fulfill({ json: gist }).catch(() => {});
  });
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#import-gist").click();
  await page.locator("#gist-input").fill(id);
  await page.locator("#gist-submit").click();
  await expect(page.locator("#build-state")).toHaveText("Loading gist");
  await page.locator("#gist-cancel").click();
  await expect(page.locator("#build-state")).toHaveText("Import canceled");
  release();
  await expect(page.locator("#project-title")).toHaveText("Untitled project");
  await expect(page).not.toHaveURL(/gist=/);
});
