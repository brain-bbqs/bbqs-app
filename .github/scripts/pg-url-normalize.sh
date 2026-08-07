#!/usr/bin/env bash
# Usage: source .github/scripts/pg-url-normalize.sh <ENV_VAR_NAME> [OUT_VAR_NAME]
# Validates a PostgreSQL connection string and writes a normalized (safely
# percent-encoded) copy to $GITHUB_ENV as OUT_VAR_NAME (default: DB_URL_SAFE).
#
# WHY: the Supabase CLI fails with "failed to parse connection string" when the
# secret contains raw special characters in the password (@ : / ? # % etc.),
# stray quotes/whitespace, or a psql-style "postgresql://" copy with extra text.
set -euo pipefail

VAR_NAME="${1:-}"
OUT_NAME="${2:-DB_URL_SAFE}"
[ -n "$VAR_NAME" ] || { echo "::error::Usage: source $0 <ENV_VAR_NAME> [OUT_VAR_NAME]" >&2; exit 1; }
URL="${!VAR_NAME}"
[ -n "$URL" ] || { echo "::error::$VAR_NAME is empty" >&2; exit 1; }
export URL VAR_NAME OUT_NAME

python3 - <<'PY'
import os, re, sys, urllib.parse

url = os.environ['URL'].strip().strip('"').strip("'")
var_name = os.environ['VAR_NAME']
out_name = os.environ['OUT_NAME']

m = re.match(r'^(postgres(?:ql)?)://([^:/@]+)(?::(.*))?@([^/@?]+)(/[^?]*)?(\?.*)?$', url, re.S)
if not m:
    print(
        f"::error::{var_name} is not a valid PostgreSQL connection string. "
        "Expected postgresql://<user>:<password>@<host>:<port>/<database> with no "
        "surrounding quotes, spaces, or newlines. Copy it from Supabase -> Connect -> "
        "Session pooler (port 5432).",
        file=sys.stderr,
    )
    sys.exit(1)

scheme, user, password, hostport, path, query = m.groups()
password = password or ''

if '\n' in url or ' ' in url:
    print(f"::error::{var_name} contains whitespace or a newline; re-paste the secret on a single line.", file=sys.stderr)
    sys.exit(1)

# Re-encode the password so special characters can't break the URI parser.
password = urllib.parse.quote(urllib.parse.unquote(password), safe='')
user = urllib.parse.quote(urllib.parse.unquote(user), safe='')

safe = f"{scheme}://{user}:{password}@{hostport}{path or '/postgres'}{query or ''}"

host = hostport.split('@')[-1].split(':')[0]
if host.startswith('db.') and host.endswith('.supabase.co'):
    print(
        f"::error::{var_name} uses Supabase's IPv6-only direct host ({host}). "
        "Use the Session pooler connection string (port 5432) instead.",
        file=sys.stderr,
    )
    sys.exit(1)

env_path = os.environ.get('GITHUB_ENV')
line = f"{out_name}={safe}"
if env_path:
    with open(env_path, 'a') as f:
        f.write(line + '\n')
print(f"::add-mask::{safe}")
print(f"Normalized {var_name} -> {out_name} (host {host})")
PY
