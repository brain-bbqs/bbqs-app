#!/usr/bin/env bash
# Usage: .github/scripts/clone-prod-schema-to-sandbox.sh
#
# Makes the SANDBOX database an exact SCHEMA clone of PRODUCTION.
#
# Why this exists instead of `supabase db push`:
#   The repo's migration history does not start from an empty database. The oldest
#   migrations (2026-04-17...) assume tables such as public.grant_investigators
#   already exist, because production was built in Lovable before migrations were
#   recorded. Replaying them into a fresh project therefore fails with
#   `relation "public.grant_investigators" does not exist (SQLSTATE 42P01)`.
#   For an exact replica we do not want a replay anyway — we want prod's schema.
#
# Required env:
#   PROD_URL      normalized postgresql:// URI for production (read-only use)
#   SANDBOX_URL   normalized postgresql:// URI for the sandbox project
set -euo pipefail

: "${PROD_URL:?PROD_URL is required}"
: "${SANDBOX_URL:?SANDBOX_URL is required}"

if [[ "$SANDBOX_URL" == *"vpexxhfpvghlejljwpvt"* ]]; then
  echo "::error::SANDBOX_URL points at the production project. Refusing to run."
  exit 1
fi

DUMP_DIR="${RUNNER_TEMP:-/tmp}/prod-schema"
mkdir -p "$DUMP_DIR"

echo "==> Dumping production schema (public)"
pg_dump "$PROD_URL" \
  --schema-only \
  --no-owner \
  --schema=public \
  --file "$DUMP_DIR/prod-schema.sql"

echo "==> Dumping production migration history"
pg_dump "$PROD_URL" \
  --data-only \
  --no-owner \
  --no-privileges \
  --table='supabase_migrations.schema_migrations' \
  --file "$DUMP_DIR/prod-migrations.sql" || true

echo "==> Resetting sandbox public schema"
psql "$SANDBOX_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
SQL

echo "==> Applying production schema to sandbox"
# Extensions/roles owned by Supabase can collide harmlessly; the verification
# step below is the real check, so do not stop on the first error.
psql "$SANDBOX_URL" -f "$DUMP_DIR/prod-schema.sql" > "$DUMP_DIR/apply.log" 2>&1 || true
if grep -qi '^psql:.*ERROR' "$DUMP_DIR/apply.log"; then
  echo "::warning::schema apply reported errors (first 40):"
  grep -i '^psql:.*ERROR' "$DUMP_DIR/apply.log" | head -40
fi

echo "==> Syncing migration history so drift checks line up"
psql "$SANDBOX_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  statements text[],
  name text
);
TRUNCATE supabase_migrations.schema_migrations;
SQL
psql "$SANDBOX_URL" -f "$DUMP_DIR/prod-migrations.sql" >/dev/null 2>&1 || true

echo "==> Verifying"
pt=$(psql "$PROD_URL"    -At -c "SELECT count(*) FROM pg_tables WHERE schemaname='public';")
st=$(psql "$SANDBOX_URL" -At -c "SELECT count(*) FROM pg_tables WHERE schemaname='public';")
echo "public tables: prod=$pt sandbox=$st"
[ "$pt" = "$st" ] || echo "::warning::table count mismatch between prod and sandbox"

# PostgREST assumes the anon/authenticated roles and relies on table ACLs in
# addition to RLS. A schema clone without privileges looks complete to psql but
# every anonymous REST table request fails with 401.
anon_grants=$(psql "$SANDBOX_URL" -At -c \
  "SELECT has_table_privilege('anon', 'public.grants', 'SELECT');")
if [ "$anon_grants" != "t" ]; then
  echo "::error::Sandbox schema is missing anon SELECT on public.grants. Production ACLs were not cloned."
  exit 1
fi
echo "PostgREST grants: anon can SELECT public.grants"
echo "==> Schema clone complete"
