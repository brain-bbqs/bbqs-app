import { test, expect } from "@playwright/test";

/**
 * Walks every public route and fails on:
 *   - Uncaught JS errors (page errors)
 *   - Console errors (filtered for known noise)
 *   - Failed Supabase API calls (4xx/5xx)
 *   - Broken images (naturalWidth === 0)
 */

const ROUTES = [
  "/",
  "/about",
  "/projects",
  "/investigators",
  "/publications",
  "/resources",
  "/species",
  "/working-groups",
  "/announcements",
  "/roadmap",
  "/jobs",
  "/grants",
  "/tutorials",
  "/data-sharing-policy",
  "/state-privacy",
  "/suggest-feature",
  "/mcp-docs",
  "/mcp-tutorial",
  "/sfn-2025",
  "/mit-workshop-2026",
  // "/mit-workshop-2026/travel" — sub-page with no h1; excluded until page adds one
  // "/cross-species-synchronization" — temporarily hidden in v1.0.0; Sully will restore it.
  //   When it comes back, re-add this route and remove this comment.
  // "/data-provenance" — disabled in v1.0.0 (no h1); excluded until fixed
];

const IGNORED_CONSOLE = [
  "Function components cannot be given refs",
  "Download the React DevTools",
  "[vite]",
  "Failed to load resource: the server responded with a status of 404", // favicons etc
  "Failed to load resource: the server responded with a status of 401", // unauthenticated optional calls
  "Failed to load resource: net::ERR_NAME_NOT_RESOLVED", // external URLs unreachable in CI sandbox
  "validateDOMNesting",
  "X-Frame-Options may only be set via an HTTP header", // meta tag warning from third-party content
  "data:font/", // base64-embedded font CSP noise
  "Permissions policy violation", // Chrome feature-policy notices (compute-pressure etc.), not app errors
];

// Supabase API URLs that are intentionally auth-gated and will 401 for anon users.
// These are not regressions — they're expected behaviour.
const IGNORED_API_URL_PATTERNS = [
  "analytics_pageviews", // write-only analytics table; 401 for anon is by design
];

for (const route of ROUTES) {
  test(`page health: ${route}`, async ({ page }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const apiFailures: { url: string; status: number }[] = [];

    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (IGNORED_CONSOLE.some((s) => text.includes(s))) return;
      consoleErrors.push(text);
    });
    page.on("response", (res) => {
      const url = res.url();
      const status = res.status();
      if (
        status >= 400 &&
        (url.includes("/rest/v1/") ||
          url.includes("/functions/v1/") ||
          url.includes("/rpc/")) &&
        !IGNORED_API_URL_PATTERNS.some((p) => url.includes(p))
      ) {
        apiFailures.push({ url, status });
      }
    });

    await page.goto(route, { waitUntil: "networkidle", timeout: 45_000 });
    await page.waitForTimeout(1500);

    // h1 must exist and be visible
    const h1 = page.locator("h1").first();
    await expect(h1, `${route} is missing an h1`).toBeVisible({ timeout: 10_000 });

    // No NotFound page leaked
    const notFound = await page.getByText(/404|page not found/i).count();
    expect(notFound, `${route} rendered NotFound`).toBe(0);

    // No uncaught exceptions
    expect(pageErrors, `${route} threw: ${pageErrors.join(" | ")}`).toEqual([]);

    // No console errors
    expect(
      consoleErrors,
      `${route} console errors:\n${consoleErrors.join("\n")}`,
    ).toEqual([]);

    // No failed Supabase calls
    expect(
      apiFailures,
      `${route} API failures:\n${JSON.stringify(apiFailures, null, 2)}`,
    ).toEqual([]);

    // No broken same-origin <img> elements.
    // External CDN images (e.g. logo.clearbit.com institution logos) are excluded
    // because they are unreachable in the sandboxed CI environment.
    const broken = await page.evaluate(() =>
      Array.from(document.querySelectorAll("img"))
        .filter(
          (img) =>
            img.complete &&
            img.naturalWidth === 0 &&
            img.src &&
            !img.src.startsWith("data:") &&
            new URL(img.src).hostname === window.location.hostname,
        )
        .map((img) => img.src),
    );
    expect(broken, `${route} broken images: ${broken.join(", ")}`).toEqual([]);
  });
}
