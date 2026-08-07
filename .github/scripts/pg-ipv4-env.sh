#!/usr/bin/env bash
# Usage: source .github/scripts/pg-ipv4-env.sh <ENV_VAR_NAME>
# Reads an IPv4-capable PostgreSQL connection string from the named environment
# variable and writes libpq env vars to $GITHUB_ENV. Supabase direct hosts
# (db.<project-ref>.supabase.co) are IPv6-only and must not be used on GitHub's
# IPv4-only hosted runners; use the Session pooler URI on port 5432 instead.
set -euo pipefail

VAR_NAME="${1:-}"
[ -n "$VAR_NAME" ] || { echo "::error::Usage: source $0 <ENV_VAR_NAME>" >&2; exit 1; }

# indirect expansion to read the connection string
URL="${!VAR_NAME}"
[ -n "$URL" ] || { echo "::error::$VAR_NAME is empty" >&2; exit 1; }
export URL VAR_NAME

python3 - <<'PY'
import os, sys, socket, urllib.parse

url = os.environ['URL']
var_name = os.environ['VAR_NAME']
env_path = os.environ.get('GITHUB_ENV')

p = urllib.parse.urlparse(url)
if p.scheme not in ('postgres', 'postgresql'):
    print(f"::error::Unsupported connection scheme: {p.scheme}", file=sys.stderr)
    sys.exit(1)

host = p.hostname
if not host:
    print("::error::Could not parse host from connection string", file=sys.stderr)
    sys.exit(1)

if host.startswith('db.') and host.endswith('.supabase.co'):
    print(
        f"::error::{var_name} uses Supabase's IPv6-only direct database host ({host}). "
        "Replace this GitHub Actions secret with the Session pooler connection string "
        "from Supabase → Connect → Session pooler (port 5432).",
        file=sys.stderr,
    )
    sys.exit(1)

port = p.port or 5432
user = p.username or 'postgres'
password = p.password or ''
dbname = p.path.lstrip('/') or 'postgres'

query = urllib.parse.parse_qs(p.query)
sslmode = query.get('sslmode', [None])[0]

try:
    addrinfo = socket.getaddrinfo(host, None, socket.AF_INET)
    ipv4 = addrinfo[0][4][0]
except Exception as e:
    print(f"::error::Could not resolve IPv4 for {host}: {e}", file=sys.stderr)
    sys.exit(1)

lines = [
    f"PGHOST={host}",
    f"PGHOSTADDR={ipv4}",
    f"PGPORT={port}",
    f"PGUSER={user}",
    f"PGPASSWORD={password}",
    f"PGDATABASE={dbname}",
]
if sslmode:
    lines.append(f"PGSSLMODE={sslmode}")

if env_path:
    with open(env_path, 'a') as f:
        for line in lines:
            f.write(line + '\n')
else:
    for line in lines:
        print(line)
PY
