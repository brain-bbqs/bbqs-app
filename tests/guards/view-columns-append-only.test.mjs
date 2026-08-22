// Guard: CREATE OR REPLACE VIEW may only APPEND columns. Redefining a view with a column inserted,
// reordered or removed is not something Postgres tolerates — it compares positionally and refuses:
//
//     42P16: cannot change name of view column "record_label" to "priority"
//
// WHY THIS EXISTS. Three incidents in one week's work, all the same mistake:
//   * the questionnaire-status view, rebuilt from an older definition that lacked two trailing
//     columns a later migration had added;
//   * field_provenance_current, which needed authored_at and had to use ALTER VIEW RENAME COLUMN,
//     because CREATE OR REPLACE cannot rename;
//   * provenance_worklist, where `priority` was written before `record_label`, and Postgres read
//     that as a rename of record_label.
//
// The failure is total — the whole migration rolls back — and it only appears when the SQL runs,
// which in this project means after a human has pasted it into the SQL editor. A file check is free.
//
// THE RULE: when a migration redefines a view an earlier migration already defined, the earlier
// column list must be a PREFIX of the new one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS = join(ROOT, "supabase", "migrations");

const sqlFiles = () =>
  readdirSync(MIGRATIONS)
    .filter((f) => extname(f) === ".sql")
    .sort()
    .map((f) => join(MIGRATIONS, f))
    .filter((f) => statSync(f).isFile());

/** Strip SQL comments. Needed in two places, for two different reasons — see below.
 *
 *  CRLF matters here, and cost an hour. These files are checked out with \r\n on Windows — git says
 *  so on every commit. Splitting on "\n" alone leaves a trailing \r, and in a JS regex `.` does not
 *  match \r while `$` cannot match after it, so `--.*$` silently removed NOTHING, in every file.
 *  The guard then read comment prose as column names and reported "column 19 changed from Appended
 *  to authored_at". Split on /\r?\n/ and drop the anchor. */
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*/, ""))
    .join("\n");

/** Split a select list on commas that are not inside parentheses. */
function topLevelSplit(list) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Output column names of a view definition, in order. */
function viewColumns(sql, startIdx) {
  const after = stripComments(sql.slice(startIdx));
  const selIdx = after.search(/\bSELECT\b/);
  if (selIdx === -1) return null;

  // A CTE view — `AS WITH base AS (SELECT ...)` — puts a SELECT before its OUTPUT select, so the
  // first one belongs to the CTE. onboarding_pipeline is shaped that way, and reading the CTE's
  // columns made this guard report three long-applied migrations as broken. Short of a real SQL
  // parser, abstaining is the only honest option: a guard that is wrong is worse than one that
  // admits it cannot see. The next test names what was skipped.
  if (/\bAS\s+WITH\b/i.test(after.slice(0, selIdx).replace(/\s+/g, " "))) return null;

  // The select list ends at the view's own FROM — meaning the FROM at PAREN DEPTH ZERO. The first
  // version of this took the first line-initial FROM, which for onboarding_pipeline sits inside
  // `(SELECT count(*) FROM jsonb_each_text(...)) AS steps_done`. It truncated there, silently lost
  // four columns, and then reported three long-applied migrations as broken. They were fine; the
  // parser was not. A guard with a broken parser reports confidently about nothing.
  let depth = 0;
  let end = -1;
  for (let i = selIdx + 6; i < after.length; i += 1) {
    const ch = after[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && /\s/.test(ch) && /^FROM\b/i.test(after.slice(i + 1, i + 6))) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) return null;

  const list = after
    .slice(selIdx + 6, end)
    .replace(/^\s*DISTINCT\s+ON\s*\([\s\S]*?\)/i, "");

  return topLevelSplit(list)
    .map((item) => {
      const t = item.trim().replace(/\s+/g, " ");
      if (!t) return null;
      const aliased = t.match(/\bAS\s+"?([a-zA-Z_][a-zA-Z_0-9]*)"?$/i);
      if (aliased) return aliased[1];
      const bare = t.match(/([a-zA-Z_][a-zA-Z_0-9]*)$/);
      return bare ? bare[1] : null;
    })
    .filter(Boolean);
}

/** Every view definition across the migrations, in file order — with renames applied.
 *
 *  ALTER VIEW ... RENAME COLUMN is the sanctioned way to rename a view column, and the first
 *  version of this guard did not know it existed: it flagged a later CREATE OR REPLACE as
 *  "changes source_rank to source_grade" when a migration in between had legitimately renamed
 *  exactly that column. A guard that does not model a legal operation reports correct code as
 *  broken, which is how guards get switched off. */
function viewDefinitions() {
  const defs = new Map();
  const renames = new Map(); // view -> [{from, to}] seen so far
  for (const f of sqlFiles()) {
    // Comments stripped before the scan too: this very file's error message contains the phrase
    // "CREATE OR REPLACE VIEW cannot insert, reorder or drop", and the scanner duly reported a
    // view named `cannot`.
    const sql = stripComments(readFileSync(f, "utf8"));
    const re = /CREATE\s+OR\s+REPLACE\s+VIEW\s+(?:public\.)?([a-z_0-9]+)/gi;
    let m;
    while ((m = re.exec(sql)) !== null) {
      const cols = viewColumns(sql, m.index);
      if (!cols || cols.length === 0) continue;
      if (!defs.has(m[1])) defs.set(m[1], []);
      defs.get(m[1]).push({ file: basename(f), cols });
    }

    // Apply any renames THIS file performs, so a later definition is compared against the column
    // names the view actually has by then.
    const rn = /ALTER\s+VIEW\s+(?:public\.)?([a-z_0-9]+)\s+RENAME\s+COLUMN\s+([a-z_0-9]+)\s+TO\s+([a-z_0-9]+)/gi;
    let r;
    while ((r = rn.exec(sql)) !== null) {
      const [, view, from, to] = r;
      if (!renames.has(view)) renames.set(view, []);
      renames.get(view).push({ from, to });
      const history = defs.get(view);
      if (history) {
        for (const d of history) {
          d.cols = d.cols.map((c) => (c === from ? to : c));
        }
      }
    }
  }
  return defs;
}

test("the extractor reads a view's columns in order", () => {
  const sample = `CREATE OR REPLACE VIEW public.demo AS
SELECT DISTINCT ON (a.x) a.alpha,
       b.beta AS renamed,
       -- a comment that mentions gamma
       coalesce(a.p, b.q, 'x') AS third
  FROM public.a a;`;
  assert.deepEqual(viewColumns(sample, 0), ["alpha", "renamed", "third"]);
});

test("comments are stripped even with CRLF line endings", () => {
  // Pins the bug above: with \r\n, `--.*$` matched nothing, the comment survived, and its prose was
  // parsed as a column name. These migrations are checked out CRLF on Windows, so this is the
  // ordinary case rather than an edge one.
  const crlf =
    "CREATE OR REPLACE VIEW public.demo AS\r\n" +
    "SELECT a.one,\r\n" +
    "       -- Appended, not inserted.\r\n" +
    "       a.two\r\n" +
    "  FROM public.a a;";
  assert.deepEqual(viewColumns(crlf, 0), ["one", "two"]);
});

test("the extractor is not fooled by a FROM inside a subquery", () => {
  // The exact shape that broke the first version.
  const sample = `CREATE OR REPLACE VIEW public.demo AS
SELECT i.id,
       (SELECT count(*) FROM public.other o
         WHERE o.id = i.id) AS tally,
       i.tail
  FROM public.i i;`;
  assert.deepEqual(viewColumns(sample, 0), ["id", "tally", "tail"]);
});

test("views this guard cannot read are named, not silently skipped", () => {
  // Coverage is partial by construction. Saying so out loud stops "the suite is green" from being
  // read as "every view was checked" — the same absence-looks-like-good-news problem the provenance
  // work exists to remove, one layer up.
  const skipped = new Set();
  for (const f of sqlFiles()) {
    const sql = stripComments(readFileSync(f, "utf8"));
    const re = /CREATE\s+OR\s+REPLACE\s+VIEW\s+(?:public\.)?([a-z_0-9]+)/gi;
    let m;
    while ((m = re.exec(sql)) !== null) {
      if (viewColumns(sql, m.index) === null) skipped.add(m[1]);
    }
  }
  const names = [...skipped].sort();
  console.log(
    names.length
      ? `      note: ${names.length} view(s) not checked (CTE-based): ${names.join(", ")}`
      : "      note: every CREATE OR REPLACE VIEW was readable",
  );
  assert.ok(true);
});

test("a redefined view only ever appends columns", () => {
  const problems = [];
  for (const [name, defs] of viewDefinitions()) {
    for (let i = 1; i < defs.length; i += 1) {
      const prev = defs[i - 1];
      const next = defs[i];
      const at = prev.cols.findIndex((c, j) => c !== next.cols[j]);
      if (at !== -1) {
        problems.push(
          `${name}: ${next.file} changes column ${at} from "${prev.cols[at]}" to ` +
            `"${next.cols[at] ?? "(missing)"}" (previously defined in ${prev.file}). ` +
            `Append instead, or use ALTER VIEW RENAME COLUMN.`,
        );
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});
