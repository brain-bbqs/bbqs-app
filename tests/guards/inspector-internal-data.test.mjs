// Guard: the working-group meeting notes and the device list reach the Graph Inspector only in the
// artifact build, never the repo or the public site.
//
// WHY (2026-11-16). The Inspector gained a Meetings tab: lessons, disagreements and decisions from
// the working-group notes, each tied to the person the notes attribute it to. Those notes are
// internal, and so is the device list (2026-11-16), which names who spoke to each device. The same
// template builds three pages: kg/browser/index.html (committed),
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
const MARK = /"kind":\s*"bbqs-(meetings|devices)"/;

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
  // The whole file, not one line: a flag on a continuation line or in a variable counts too.
  for (const sub of ["workflows", "scripts", "actions"]) {
    const dir = join(ROOT, ".github", sub);
    let names = [];
    try { names = readdirSync(dir, { recursive: true }).map(String); } catch { continue; }
    for (const name of names.filter((n) => /\.(ya?ml|sh|py|mjs|js)$/.test(n))) {
      const src = read(join(".github", sub, name));
      assert.doesNotMatch(src, /--internal\b/, `.github/${sub}/${name} passes --internal`);
      assert.doesNotMatch(src, /\b(meetings|devices)\.py\b|kg\.(meetings|devices)\b/, `.github/${sub}/${name} runs kg/meetings.py or kg/devices.py; the records stay off CI`);
    }
  }
  const scripts = JSON.stringify(JSON.parse(read("package.json")).scripts || {});
  assert.doesNotMatch(scripts, /--internal\b|\b(meetings|devices)\.py\b/, "a package.json script builds the internal records");
});

test("no meeting records are committed", () => {
  // Any file holding a marker, the template the public site ships included, is a copy of the records. Text-like files only, and not node_modules, dist or the git store.
  const allowed = new Set();    // kg/meetings.py and kg/devices.py build the marker from a constant, so no file is exempt
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

test("no raw copy of the notes or the device list is committed", () => {
  // The inputs carry no marker, so they are known by name: the extraction of the meeting notes and
  // the device list's files (kg/meetings.py and kg/devices.py read them from outside the repo).
  const raw = new Set(["meetings_extracted.json", "meetings_flat.csv", "person_roles.csv", "devices.csv",
                       "device_evidence.csv", "device_discussion_crosscutting.csv", "bbqs_devices_kg.json"]);
  const skip = new Set([".git", "node_modules", "dist", ".venv"]);
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (raw.has(name)) hits.push(relative(ROOT, full).split("\\").join("/"));
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, [], "the notes and the device list belong outside the repository");
});
