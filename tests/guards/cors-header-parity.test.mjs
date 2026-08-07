// Static guard suite — zero dependencies, runs with Node's built-in test runner:
//   npm run test:guards
//
// These encode CROSS-LAYER invariants that no single-file review catches. Each test exists
// because a real outage happened when the invariant was violated (2026-08-07):
//   • A global header on the supabase client (X-BBQS-Client, added for audit provenance) is
//     sent by supabase-js on EVERY request including functions.invoke. Each edge function has
//     a HAND-WRITTEN CORS allow-list, so the preflight was rejected — silently breaking the
//     projects page (nih-grants), chat, add-project, and more. Two facts, both knowable, never
//     composed. This suite composes them mechanically instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLIENT = join(ROOT, "src", "integrations", "supabase", "client.ts");
const FUNCS_DIR = join(ROOT, "supabase", "functions");

/** Extract the balanced {...} object literal that follows `key:` (or null). */
function objectAfter(src, key) {
  const at = src.indexOf(key);
  if (at === -1) return null;
  const open = src.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/** Custom request-header names the supabase client sets GLOBALLY (lowercased). */
function globalClientHeaders() {
  if (!existsSync(CLIENT)) return [];
  const src = readFileSync(CLIENT, "utf8");
  // Ignore comments so documentation mentioning a header name isn't parsed as code.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const globalBlock = objectAfter(code, "global:");
  if (!globalBlock) return [];
  const headersBlock = objectAfter(globalBlock, "headers:");
  if (!headersBlock) return [];
  return [...headersBlock.matchAll(/["']([A-Za-z0-9-]+)["']\s*:/g)].map((m) => m[1].toLowerCase());
}

/** Browser-callable edge functions = those declaring an Access-Control-Allow-Headers list. */
function browserCallableFunctions() {
  if (!existsSync(FUNCS_DIR)) return [];
  const out = [];
  for (const name of readdirSync(FUNCS_DIR)) {
    if (name.startsWith("_")) continue;
    const file = join(FUNCS_DIR, name, "index.ts");
    if (!existsSync(file)) continue;
    const src = readFileSync(file, "utf8");
    const m = src.match(/["']Access-Control-Allow-Headers["']\s*:\s*["']([^"']*)["']/i);
    if (!m) continue;
    out.push({
      name,
      src,
      allowed: m[1].split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    });
  }
  return out;
}

test("every GLOBAL supabase-client header is allowed by every browser-callable edge function", () => {
  const globals = globalClientHeaders();
  const funcs = browserCallableFunctions();
  assert.ok(funcs.length > 0, "no browser-callable edge functions found — check FUNCS_DIR");

  const violations = [];
  for (const h of globals) {
    for (const f of funcs) {
      if (!f.allowed.includes(h)) violations.push(`${f.name}: missing '${h}'`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `A global header on the supabase client must be in EVERY edge function's ` +
      `Access-Control-Allow-Headers, or its CORS preflight fails and the feature breaks in the ` +
      `browser (works in curl — no preflight — which makes it look like a backend bug).\n` +
      `Global header(s): ${globals.join(", ") || "(none)"}\n` +
      `Violations:\n  ${violations.join("\n  ")}\n` +
      `Fix: prefer NOT setting global headers (tag per-write instead); otherwise update all functions.`,
  );
});

test("browser-callable edge functions allow the baseline supabase-js headers", () => {
  // supabase-js always sends these; omitting any breaks the preflight.
  const BASELINE = ["authorization", "x-client-info", "apikey", "content-type"];
  const missing = [];
  for (const f of browserCallableFunctions()) {
    for (const h of BASELINE) if (!f.allowed.includes(h)) missing.push(`${f.name}: missing '${h}'`);
  }
  assert.deepEqual(missing, [], `Incomplete CORS allow-list:\n  ${missing.join("\n  ")}`);
});

test("browser-callable edge functions answer the OPTIONS preflight", () => {
  const bad = browserCallableFunctions()
    .filter((f) => !/OPTIONS/.test(f.src))
    .map((f) => f.name);
  assert.deepEqual(bad, [], `These declare CORS but never handle OPTIONS: ${bad.join(", ")}`);
});
