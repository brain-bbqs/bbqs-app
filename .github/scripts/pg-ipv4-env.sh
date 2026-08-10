#!/usr/bin/env bash
# Usage: source .github/scripts/pg-ipv4-env.sh <ENV_VAR_NAME>
#
# Reads a PostgreSQL connection string from the named environment variable and writes libpq env
# vars to $GITHUB_ENV. When the host has an IPv4 (A) record we ALSO pin PGHOSTADDR to it, which
# avoids IPv6-only egress problems on hosted runners.
#
# This is an OPTIMISATION, NOT A GATE. An earlier version hard-failed when the host looked like
# Supabase's direct host (db.<ref>.supabase.co) or had no A record — which broke a backup that
# had been working for months (last green 2026-08-07 08:18, every run after the guard landed
# failed at "Resolve DB IPv4"). Whether the runner can actually reach the host is not knowable
# from the hostname: if IPv4 is unavailable we simply leave PGHOSTADDR unset and let libpq
# resolve and connect as it always did, so pg_dump's own error is the ground truth rather than
# our prediction. Using the Session pooler URI (port 5432) is still PREFERABLE — it is
# IPv4-reachable — but it requires the DB password, so it must not be a precondition for the
# backup running at all.
set -euo pipefail

VAR_NAME="${1:-}"
[ -n "$VAR_NAME" ] || { echo "::error::Usage: source $0 <ENV_VAR_NAME>" >&2; exit 1; }

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

port     = p.port or 5432
user     = p.username or 'postgres'
password = p.password or ''
dbname   = p.path.lstrip('/') or 'postgres'
sslmode  = urllib.parse.parse_qs(p.query).get('sslmode', [None])[0]

lines = [
    f"PGHOST={host}",
    f"PGPORT={port}",
    f"PGUSER={user}",
    f"PGPASSWORD={password}",
    f"PGDATABASE={dbname}",
]
if sslmode:
    lines.append(f"PGSSLMODE={sslmode}")

# Pin IPv4 when we can. If we cannot, warn and continue — do NOT fail the backup.
try:
    ipv4 = socket.getaddrinfo(host, None, socket.AF_INET)[0][4][0]
    lines.append(f"PGHOSTADDR={ipv4}")
    print(f"Resolved {host} -> {ipv4} (IPv4 pinned)")
except Exception as e:
    print(
        f"::warning::No IPv4 (A) record for {host} ({e}). Continuing without pinning — libpq "
        "will resolve normally. If the connection then fails on an IPv4-only runner, switch "
        f"{var_name} to the Supabase Session pooler URI (Connect → Session pooler, port 5432).",
    )

if env_path:
    with open(env_path, 'a') as f:
        f.write("\n".join(lines) + "\n")
else:
    print("\n".join(lines))
PY
