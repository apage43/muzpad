import type { Page } from "@playwright/test";

/** Open the visible group containing a real command, without activating it. */
export async function openCommandMenu(page: Page, selector: string) {
  const control = page.locator(selector);
  const menu = control.locator("xpath=ancestor::details[1]");
  if (await menu.count() && await menu.getAttribute("open") === null)
    await menu.locator(":scope > summary").click();
}

/** Exercise the visible grouped command before invoking its real control. */
export async function clickCommand(page: Page, selector: string) {
  await openCommandMenu(page, selector);
  await page.locator(selector).click();
}
