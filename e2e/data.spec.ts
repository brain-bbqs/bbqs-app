import { test, expect } from "@playwright/test";
import { CORE_TABLES } from "./routes";
import { supabaseAnonymousHeaders } from "./supabase-headers";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const AUTH_HEADERS = supabaseAnonymousHeaders(ANON_KEY);

test.describe("tables load with data", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!SUPABASE_URL || !ANON_KEY, "SUPABASE_URL / SUPABASE_ANON_KEY not set");

  // Use Auth settings for key validation. Supabase now restricts the bare
  // /rest/v1/ schema endpoint to service_role even when the anon key is valid.
  test("anon key is accepted by the sandbox API", async ({ request }) => {
    const res = await request.get(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: AUTH_HEADERS,
    });
    expect(
      res.status(),
      `Auth settings -> ${res.status()}. 401 means the API key does not belong to ${SUPABASE_URL}.`
    ).toBeLessThan(400);
  });

  for (const table of CORE_TABLES) {
    test(`table has rows: ${table}`, async ({ request }) => {
      const res = await request.head(
        `${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`,
        {
          headers: {
            ...AUTH_HEADERS,
            Prefer: "count=exact",
          },
        }
      );
      expect(
        res.status(),
        `${table} REST status -> ${res.status()}${res.status() === 401 ? " (API key was rejected or does not belong to this sandbox project)" : ""}`
      ).toBeLessThan(400);
      const range = res.headers()["content-range"] ?? "";
      const total = Number(range.split("/")[1] ?? "0");
      expect(total, `${table} row count (content-range: ${range})`).toBeGreaterThan(0);
    });
  }
});
