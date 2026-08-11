#!/usr/bin/env bash
# Usage: .github/scripts/clone-prod-to-sandbox.sh
#
# Makes the SANDBOX database an exact data clone of PRODUCTION.
# Schema is already in place (migrations were pushed just before this runs);
# this replaces every row in the sandbox with production's rows.
#
# Required env:
#   PROD_URL      normalized postgresql:// URI for the production project (read-only use)
#   SANDBOX_URL   normalized postgresql:// URI for the sandbox project
# Optional env:
#   CLONE_AUTH    'true' (default) also clones auth.users and storage metadata
#
# WARNING: this copies real production data — including PII — into the sandbox.
# The sandbox must therefore be treated as a production-confidentiality system:
# no public seeding, no shared credentials, access limited to the same people
# who can read production.
set -euo pipefail

: "${PROD_URL:?PROD_URL is required}"
: "${SANDBOX_URL:?SANDBOX_URL is required}"
CLONE_AUTH="${CLONE_AUTH:-true}"

# Refuse to write into production by mistake.
if [[ "$SANDBOX_URL" == *"vpexxhfpvghlejljwpvt"* ]]; then
  echo "::error::SANDBOX_URL points at the production project. Refusing to run."
  exit 1
fi
if [[ "$PROD_URL" != *"vpexxhfpvghlejljwpvt"* ]]; then
  echo "::warning::PROD_URL does not look like the production project ref."
fi

DUMP_DIR="${RUNNER_TEMP:-/tmp}/prod-clone"
mkdir -p "$DUMP_DIR"

SCHEMAS=(--schema=public)
if [ "$CLONE_AUTH" = "true" ]; then
  SCHEMAS+=(--schema=auth --schema=storage)
fi

echo "==> Dumping production data (${SCHEMAS[*]})"
pg_dump "$PROD_URL" \
  --data-only \
  --no-owner \
  --no-privileges \
  --disable-triggers \
  --format=custom \
  "${SCHEMAS[@]}" \
  --exclude-table-data='auth.audit_log_entries' \
  --exclude-table-data='auth.refresh_tokens' \
  --exclude-table-data='auth.sessions' \
  --exclude-table-data='auth.flow_state' \
  --exclude-table-data='storage.s3_multipart_uploads*' \
  --file "$DUMP_DIR/prod-data.dump"

echo "==> Emptying sandbox public schema"
psql "$SANDBOX_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  stmt text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
    INTO stmt
  FROM pg_tables
  WHERE schemaname = 'public';

  IF stmt IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || stmt || ' RESTART IDENTITY CASCADE';
  END IF;
END $$;
SQL

if [ "$CLONE_AUTH" = "true" ]; then
  echo "==> Emptying sandbox auth.users / storage.objects"
  psql "$SANDBOX_URL" <<'SQL'
TRUNCATE TABLE auth.users CASCADE;
TRUNCATE TABLE storage.objects CASCADE;
SQL
fi

echo "==> Restoring production data into sandbox"
# No --exit-on-error: Supabase-managed rows (extensions, storage internals) can
# collide harmlessly; the row counts below are the real check.
pg_restore \
  --data-only \
  --disable-triggers \
  --no-owner \
  --no-privileges \
  --dbname "$SANDBOX_URL" \
  "$DUMP_DIR/prod-data.dump" 2> "$DUMP_DIR/restore.log" || true

if grep -qi 'error' "$DUMP_DIR/restore.log"; then
  echo "::warning::pg_restore reported errors (first 40 lines):"
  head -40 "$DUMP_DIR/restore.log"
fi

echo "==> Row-count comparison (top 25 tables by production size)"
psql "$PROD_URL" -At -F'|' -c "
  SELECT relname, n_live_tup FROM pg_stat_user_tables
  WHERE schemaname='public' ORDER BY n_live_tup DESC LIMIT 25;" > "$DUMP_DIR/prod-counts.txt"

while IFS='|' read -r tbl _; do
  [ -n "$tbl" ] || continue
  p=$(psql "$PROD_URL"    -At -c "SELECT count(*) FROM public.\"$tbl\";" 2>/dev/null || echo '?')
  s=$(psql "$SANDBOX_URL" -At -c "SELECT count(*) FROM public.\"$tbl\";" 2>/dev/null || echo '?')
  flag=""
  [ "$p" != "$s" ] && flag="  <-- MISMATCH"
  printf '%-40s prod=%-8s sandbox=%-8s%s\n' "$tbl" "$p" "$s" "$flag"
done < "$DUMP_DIR/prod-counts.txt"

echo "==> Clone complete"
