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
    const status = res?.status() ?? 0;
    // GitHub Pages serves 404.html (HTTP 404) for SPA deep links; that page
    // redirects to /?/<route> and React Router restores the URL. Only a status
    // that is neither OK nor the Pages SPA fallback is a real failure.
    if (status >= 400 && status !== 404) {
      throw new Error(`HTTP status for ${route}: ${status}`);
    }
    if (status === 404) {
      await page.waitForURL((u) => !u.pathname.endsWith("/404.html"), { timeout: 15_000 }).catch(() => {});
    }

    // SPA shell mounted and produced visible content.
    await expect(page.locator("#root")).not.toBeEmpty();
    // The SPA fallback must land back on the requested route, not the home page.
    if (status === 404 && route !== "/") {
      expect(new URL(page.url()).pathname, `SPA fallback restored URL for ${route}`).toBe(route);
    }
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
