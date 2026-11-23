// Guard: a migration that is on hold cannot be applied by pasting it.
//
// WHY (2026-11-23). Migrations here are applied by hand: someone pastes a file into the SQL editor.
// 20261118120000_privacy_round_two was reviewed, found faulty and put on hold by the owner, but the
// file stayed in the folder, in order, looking like every other migration. A note in a header is
// vigilance; the next person to paste the folder's files in order would have applied it. So a held
// migration stops itself: its first statement raises, and nothing after it runs.
//   * a migration whose header says "-- ON HOLD" starts with a DO block that raises, naming the hold
//     and saying NOTHING WAS CHANGED;
//   * the list of held migrations is written here, so lifting a hold is a decision someone makes in a
//     change that edits this file, not a line that quietly disappears.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "migrations");
// On hold today. Remove a name here only in the change that fixes the script and removes its stop.
const HELD = ["20261118120000_privacy_round_two.sql"];

/** The first statement of a script: what runs first, comments and blank lines aside. */
export function firstStatement(sql) {
  const lines = sql.replace(/\r\n/g, "\n").split("\n");
  let at = 0;
  while (at < lines.length && (/^\s*(--.*)?$/.test(lines[at]))) at++;
  const rest = lines.slice(at).join("\n");
  const tag = rest.match(/^\s*DO\s+(\$[A-Za-z_]*\$)/i);
  if (!tag) return rest.slice(0, rest.indexOf(";") + 1);
  const end = rest.indexOf(tag[1], rest.indexOf(tag[1]) + tag[1].length);
  return rest.slice(0, rest.indexOf(";", end) + 1);
}
/** Whether the header (the comment lines before the first statement) says the script is on hold. */
export function saysOnHold(sql) {
  for (const line of sql.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*$/.test(line)) continue;
    if (!/^\s*--/.test(line)) return false;
    if (/^\s*--\s*ON HOLD\b/.test(line)) return true;
  }
  return false;
}
const stops = (statement) => /^\s*DO\s+\$/i.test(statement) && /RAISE\s+EXCEPTION\s+'[^']*ON HOLD[^']*NOTHING WAS CHANGED/i.test(statement)
  && !/\bIF\b|\bWHEN\b|\bEXCEPTION\s+WHEN\b/i.test(statement.replace(/RAISE\s+EXCEPTION/i, ""));

test("the detector tells a script that stops itself from one that only says so", () => {
  const held = "-- title\n-- ON HOLD (owner): do not apply\n\nDO $hold$\nBEGIN\n  RAISE EXCEPTION 'x is ON HOLD. NOTHING WAS CHANGED.';\nEND\n$hold$;\nBEGIN;\nDROP TABLE t;\n";
  assert.equal(saysOnHold(held), true);
  assert.equal(stops(firstStatement(held)), true);
  const noteOnly = "-- title\n-- ON HOLD (owner): do not apply\nBEGIN;\nDROP TABLE t;\n";
  assert.equal(saysOnHold(noteOnly), true);
  assert.equal(stops(firstStatement(noteOnly)), false, "a note in the header stops nothing");
  const later = "-- ON HOLD\nSELECT 1;\nDO $hold$ BEGIN RAISE EXCEPTION 'ON HOLD. NOTHING WAS CHANGED.'; END $hold$;\n";
  assert.equal(stops(firstStatement(later)), false, "the stop must be the first statement");
  const conditional = "-- ON HOLD\nDO $hold$ BEGIN IF false THEN RAISE EXCEPTION 'ON HOLD. NOTHING WAS CHANGED.'; END IF; END $hold$;\n";
  assert.equal(stops(firstStatement(conditional)), false, "a stop behind a condition is not a stop");
  assert.equal(saysOnHold("-- title\nBEGIN;\n-- ON HOLD\n"), false, "only the header counts");
});

test("a migration on hold stops itself with its first statement, and the held ones are the ones named here", () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const marked = [], unstopped = [];
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (!saysOnHold(sql)) continue;
    marked.push(f);
    if (!stops(firstStatement(sql))) unstopped.push(f);
  }
  assert.deepEqual(unstopped, [], "a held migration must begin with DO ... RAISE EXCEPTION '... ON HOLD ... NOTHING WAS CHANGED.'");
  assert.deepEqual(marked, HELD, "the migrations whose header says ON HOLD and the list in this guard differ: "
    + "lifting a hold means fixing the script, removing its stop and its notice, and removing it here, in one change");
  for (const f of HELD) assert.ok(files.includes(f), `${f} is listed as held but is not in supabase/migrations`);
});
