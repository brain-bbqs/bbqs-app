// Guard: no source file may contain a raw C0 control character where an ESCAPE SEQUENCE was meant.
//
// WHY. group-audit/index.ts shipped with four literal 0x08 bytes in place of `\b` word-boundary
// escapes, so two regex alternatives were dead: `|\bgrad\b|` in isYoungInvestigator (a bare "grad"
// role never entitled anyone to young-investigators@) and `|\bpi\b|` in roleIsUnknown (a role of
// exactly "PI" was always treated as unclassifiable). Both failed in the quiet direction and
// survived every review, because an editor renders 0x08 as nothing at all — the line LOOKS right.
//
// The cause is writing source through a shell heredoc into a language that interprets `\b`: in
// Python and JS string literals alike, '\b' IS backspace. `\s` and `\d` survive because they are
// not recognised escapes; `\b`, `\t`, `\n`, `\f`, `\v`, `\r`, `\0` do not. The corruption then
// reproduced itself when the repair used b'\bgrad\b' to write the fix, proving the failure mode is
// not a one-off slip but the default outcome of that technique. Prefer the editing tools over
// heredocs for source, and let this test catch the rest.
//
// Tabs and newlines are legitimate; every other C0 control character in a text source is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not url.pathname: this repo lives under "MIT Dropbox", and pathname keeps the
// spaces percent-encoded, which makes every readdir ENOENT.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".sql", ".css", ".json", ".md"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".temp", "coverage", ".next"]);

/** Allowed raw control bytes: TAB (0x09), LF (0x0a), CR (0x0d). */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.has(extname(entry))) yield p;
  }
}

test("no raw C0 control characters in source files", () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    const buf = readFileSync(file);
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b < 0x20 && !ALLOWED.has(b)) {
        const line = buf.subarray(0, i).toString("utf8").split("\n").length;
        offenders.push(
          `${relative(ROOT, file)}:${line} contains 0x${b.toString(16).padStart(2, "0")}` +
            ` — likely a "\\${{ 0x08: "b", 0x09: "t", 0x0c: "f", 0x0b: "v", 0x00: "0" }[b] ?? "x"}" escape written as a raw byte`,
        );
        break; // one report per file is enough to act on
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Raw control bytes found. An editor renders these as nothing, so the line looks correct:\n  ${offenders.join("\n  ")}`,
  );
});
