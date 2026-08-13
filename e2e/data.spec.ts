import { test, expect } from "@playwright/test";
import { CORE_TABLES } from "./routes";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";

test.describe("tables load with data", () => {
  test.skip(!SUPABASE_URL || !ANON_KEY, "SUPABASE_URL / SUPABASE_ANON_KEY not set");

  for (const table of CORE_TABLES) {
    test(`table has rows: ${table}`, async ({ request }) => {
      const res = await request.head(
        `${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`,
        {
          headers: {
            apikey: ANON_KEY,
            Authorization: `Bearer ${ANON_KEY}`,
            Prefer: "count=exact",
          },
        }
      );
      expect(res.status(), `${table} REST status`).toBeLessThan(400);
      const range = res.headers()["content-range"] ?? "";
      const total = Number(range.split("/")[1] ?? "0");
      expect(total, `${table} row count (content-range: ${range})`).toBeGreaterThan(0);
    });
  }
});
