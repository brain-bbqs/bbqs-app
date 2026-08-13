import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cloneScript = readFileSync(
  new URL("../../.github/scripts/clone-prod-schema-to-sandbox.sh", import.meta.url),
  "utf8",
);

test("sandbox schema clone preserves production table grants", () => {
  const schemaDump = cloneScript.match(
    /pg_dump "\$PROD_URL" \\\n([\s\S]*?)--file "\$DUMP_DIR\/prod-schema\.sql"/,
  );

  assert.ok(schemaDump, "could not locate the production schema pg_dump command");
  assert.doesNotMatch(
    schemaDump[0],
    /--no-privileges|--no-acl/,
    "stripping ACLs removes anon/authenticated PostgREST access in the sandbox",
  );
  assert.match(
    cloneScript,
    /has_table_privilege\('anon',\s*'public\.grants',\s*'SELECT'\)/,
    "clone must verify anonymous PostgREST access before reporting success",
  );
});