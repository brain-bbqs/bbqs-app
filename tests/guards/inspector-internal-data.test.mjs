// Guard: the working-group meeting notes reach the Graph Inspector only in the artifact build,
// never the repo or the public site.
//
// WHY (2026-11-16). The Inspector gained a Meetings tab: lessons, disagreements and decisions from
// the working-group notes, each tied to the person the notes attribute it to. Those notes are
// internal. The same template builds three pages: kg/browser/index.html (committed),
// /kg/inspector/ on the public site (publish.yml, daily), and the fragment published to the
// claude.ai artifact that the consortium shares. Only the last may carry the notes, and the page
// embeds whatever it is given, so one stray `--internal` in a workflow, or one rebuild of the
// committed copy with the notes, would publish them. kg/quality.py refuses an in-repo target; this
// checks what that refusal can't see: the committed copy, the workflows, and stray notes files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const MARK = /"kind":\s*"bbqs-meetings"/;

test("the template has the report placeholder, then the internal one, once each", () => {
  const src = read("kg/browser/template.html");
  const found = [...src.matchAll(/\/\*__(REPORT|INTERNAL)__\*\/null/g)].map((m) => m[1]);
  assert.deepEqual(found, ["REPORT", "INTERNAL"], "kg/quality.py render_html fills exactly these two, in this order");
});

test("the committed Inspector carries no meeting records", () => {
  const html = read("kg/browser/index.html");
  assert.match(html, /const INTERNAL = null;/, "kg/browser/index.html must be built without --internal");
  assert.doesNotMatch(html, MARK, "kg/browser/index.html holds meeting records");
});

test("no workflow builds a page with the meeting notes", () => {
  const dir = join(ROOT, ".github", "workflows");
  for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const src = read(join(".github", "workflows", name));
    assert.doesNotMatch(src, /quality\.py[^\n]*--internal/, `${name} passes --internal to kg/quality.py`);
    assert.doesNotMatch(src, /kg\/meetings\.py/, `${name} runs kg/meetings.py; the notes stay off CI`);
  }
});

test("no meeting records are committed", () => {
  // kg/meetings.py writes the marker and the template reads it; any other file holding it is a copy
  // of the notes. Text-like files only, and not node_modules, dist or the git store.
  const allowed = new Set(["kg/meetings.py", "kg/browser/template.html", "tests/guards/inspector-internal-data.test.mjs"]);
  const skip = new Set([".git", "node_modules", "dist", "playwright-report", "test-results", ".venv", "__pycache__"]);
  const text = new Set([".json", ".js", ".mjs", ".ts", ".tsx", ".py", ".html", ".md", ".csv", ".yaml", ".yml", ".ttl", ".txt", ".sql"]);
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = join(dir, name), rel = relative(ROOT, full).split("\\").join("/");
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (text.has(extname(name)) && st.size < 32 * 1024 * 1024 && !allowed.has(rel) && MARK.test(readFileSync(full, "utf8"))) hits.push(rel);
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, [], "meeting records belong outside the repository");
});
