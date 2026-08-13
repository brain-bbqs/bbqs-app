import { test, expect } from "@playwright/test";
import { CORE_TABLES } from "./routes";
import { supabaseAnonymousHeaders } from "./supabase-headers";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const AUTH_HEADERS = supabaseAnonymousHeaders(ANON_KEY);

test.describe("tables load with data", () => {
  test.skip(!SUPABASE_URL || !ANON_KEY, "SUPABASE_URL / SUPABASE_ANON_KEY not set");

  // One clear failure instead of ten identical ones when the key is wrong.
  test("anon key is accepted by the sandbox REST API", async ({ request }) => {
    const res = await request.get(`${SUPABASE_URL}/rest/v1/`, {
      headers: AUTH_HEADERS,
    });
    expect(
      res.status(),
      `REST root -> ${res.status()}. 401 means SANDBOX_SUPABASE_ANON_KEY does not belong to ${SUPABASE_URL}; use that sandbox project's publishable key.`
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
        `${table} REST status -> ${res.status()}${res.status() === 401 ? " (bad/expired sandbox anon key)" : ""}`
      ).toBeLessThan(400);
      const range = res.headers()["content-range"] ?? "";
      const total = Number(range.split("/")[1] ?? "0");
      expect(total, `${table} row count (content-range: ${range})`).toBeGreaterThan(0);
    });
  }
});
