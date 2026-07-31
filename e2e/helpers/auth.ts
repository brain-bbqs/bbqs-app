import { Page } from "@playwright/test";

/**
 * Bypass Globus auth by calling the ci-auth edge function,
 * which returns a Supabase session token for a test user.
 * The token is injected into localStorage so the app treats us as logged in.
 */
export async function loginAsTestUser(page: Page) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL || "https://vpexxhfpvghlejljwpvt.supabase.co";
  const anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwZXh4aGZwdmdobGVqbGp3cHZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk3MDg2NDUsImV4cCI6MjA4NTI4NDY0NX0.M107rJ9Ji17zAyd8Jolt5GQFZmu9vvAG1UiIq0GQh8U";

  const res = await page.request.post(`${supabaseUrl}/functions/v1/ci-auth`, {
    headers: {
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
      "Content-Type": "application/json",
    },
    data: { secret: process.env.CI_AUTH_SECRET },
  });

  if (!res.ok()) {
    throw new Error(`ci-auth failed: ${res.status()} ${await res.text()}`);
  }

  const { access_token, refresh_token } = await res.json();

  // Inject session into the same storage key the app uses.
  const storageKey = "bbqs-auth-session";
  await page.addInitScript(
    ({ key, access, refresh }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          access_token: access,
          refresh_token: refresh,
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        })
      );
    },
    { key: storageKey, access: access_token, refresh: refresh_token }
  );
}
