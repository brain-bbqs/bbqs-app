import { test, expect } from "@playwright/test";
import { PUBLIC_ROUTES, AUTH_ROUTES } from "./routes";

// Generic: every page must render without blowing up. No business assertions.
for (const route of PUBLIC_ROUTES) {
  test(`page loads: ${route}`, async ({ page }) => {
    const pageErrors: string[] = [];
    const failedAssets: string[] = [];

    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("response", (res) => {
      const url = res.url();
      if (res.status() >= 400 && /\/assets\/|\.(js|css)$/.test(url)) {
        failedAssets.push(`${res.status()} ${url}`);
      }
    });

    const res = await page.goto(route, { waitUntil: "domcontentloaded" });
    expect(res?.status(), `HTTP status for ${route}`).toBeLessThan(400);

    // SPA shell mounted and produced visible content.
    await expect(page.locator("#root")).not.toBeEmpty();
    await page.waitForLoadState("networkidle").catch(() => {});
    const text = (await page.locator("body").innerText()).trim();
    expect(text.length, `visible text on ${route}`).toBeGreaterThan(40);

    expect(pageErrors, `uncaught errors on ${route}`).toEqual([]);
    expect(failedAssets, `failed assets on ${route}`).toEqual([]);
  });
}

for (const route of AUTH_ROUTES) {
  test(`auth-gated route redirects: ${route}`, async ({ page }) => {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await expect(page).toHaveURL(/\/auth|\/request-access/);
  });
}

// D. UI-data join: DB rows must actually reach the screen.
for (const route of ["/projects", "/investigators"]) {
  test(`grid renders rows: ${route}`, async ({ page }) => {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    const rows = page.locator(
      '.ag-center-cols-container .ag-row, [data-testid="mobile-card"], table tbody tr'
    );
    await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(0);
  });
}
