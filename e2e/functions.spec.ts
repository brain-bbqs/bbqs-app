import { test, expect } from "@playwright/test";
import { SAFE_FUNCTIONS, PREFLIGHT_ONLY_FUNCTIONS } from "./routes";
import { supabaseAnonymousHeaders } from "./supabase-headers";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const AUTH_HEADERS = supabaseAnonymousHeaders(ANON_KEY);
const base = `${SUPABASE_URL}/functions/v1`;
// Edge functions are deployed per-project. If the sandbox project has no
// functions deployed, every probe is a 404 that says nothing about the app —
// so the suite is skipped unless the workflow deployed them.
const FUNCTIONS_DEPLOYED = process.env.EDGE_FUNCTIONS_DEPLOYED === "true";

// A function that booted answers something structured. 401/403/400 are fine.
// 404 (not deployed) and 5xx (boot/runtime crash) are not.
const OK = (status: number) => status !== 404 && status < 500;

test.describe("edge functions respond", () => {
  test.skip(!SUPABASE_URL || !ANON_KEY, "SUPABASE_URL / SUPABASE_ANON_KEY not set");
  test.skip(!FUNCTIONS_DEPLOYED, "EDGE_FUNCTIONS_DEPLOYED != true (no functions deployed to the sandbox)");

  for (const fn of [...SAFE_FUNCTIONS, ...PREFLIGHT_ONLY_FUNCTIONS]) {
    test(`CORS preflight: ${fn}`, async ({ request }) => {
      const res = await request.fetch(`${base}/${fn}`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://sandbox.brain-bbqs.org",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization, content-type",
        },
      });
      expect(OK(res.status()), `${fn} preflight -> ${res.status()}`).toBeTruthy();
    });
  }

  for (const fn of SAFE_FUNCTIONS) {
    test(`invoke: ${fn}`, async ({ request }) => {
      const res = await request.post(`${base}/${fn}`, {
        headers: {
          ...AUTH_HEADERS,
          "Content-Type": "application/json",
        },
        data: {},
        failOnStatusCode: false,
      });
      expect(OK(res.status()), `${fn} POST -> ${res.status()}`).toBeTruthy();
    });
  }
});
