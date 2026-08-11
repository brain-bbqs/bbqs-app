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
URL="${!VAR_NAME:-}"
# Component fallback: when the full URI secret is missing or malformed we can
# still assemble a valid Session pooler URI from a project ref + password.
FALLBACK_REF="${FALLBACK_REF:-}"
FALLBACK_PASSWORD="${FALLBACK_PASSWORD:-}"
FALLBACK_REGION="${FALLBACK_REGION:-us-east-1}"
if [ -z "$URL" ] && [ -z "$FALLBACK_PASSWORD" ]; then
  echo "::error::$VAR_NAME is empty" >&2; exit 1
fi
export URL VAR_NAME OUT_NAME FALLBACK_REF FALLBACK_PASSWORD FALLBACK_REGION

python3 - <<'PY'
import os, re, sys, urllib.parse

raw = os.environ['URL'].strip()
var_name = os.environ['VAR_NAME']
out_name = os.environ['OUT_NAME']
fb_ref = os.environ.get('FALLBACK_REF', '').strip()
fb_pw = os.environ.get('FALLBACK_PASSWORD', '').strip()
fb_region = os.environ.get('FALLBACK_REGION', 'us-east-1').strip() or 'us-east-1'

def pooler_uri():
    """Assemble the Supabase Session pooler URI from components."""
    if not (fb_ref and fb_pw):
        return None
    pw = urllib.parse.quote(fb_pw, safe='')
    return (
        f"postgresql://postgres.{fb_ref}:{pw}"
        f"@aws-0-{fb_region}.pooler.supabase.com:5432/postgres"
    )

def shape(value):
    """Redacted description of the secret so we can debug without leaking it."""
    prefix = value.split('://', 1)[0][:12] if '://' in value else '(no scheme)'
    return (
        f"length={len(value)}, scheme='{prefix}', has_at={'@' in value}, "
        f"has_colon={':' in value}, has_space={' ' in value}, "
        f"has_newline={chr(10) in value or chr(13) in value}, "
        f"quoted={value[:1] in chr(34) + chr(39)}"
    )

def emit(safe, host, note=''):
    env_path = os.environ.get('GITHUB_ENV')
    if env_path:
        with open(env_path, 'a') as f:
            f.write(f"{out_name}={safe}\n")
    print(f"::add-mask::{safe}")
    print(f"Normalized {var_name} -> {out_name} (host {host}){note}")
    sys.exit(0)

# No full URI at all, but components are available: build it.
if not raw:
    built = pooler_uri()
    if built:
        emit(built, f"aws-0-{fb_region}.pooler.supabase.com",
             " [assembled from project ref + password]")
    print(f"::error::{var_name} is empty", file=sys.stderr)
    sys.exit(1)

# Tolerate a copied "NAME=postgresql://..." assignment line.
raw = re.sub(r'^[A-Za-z_][A-Za-z0-9_]*=', '', raw)

# Supabase's Connect dialog may copy either the URI itself or a ready-to-run
# command such as: psql 'postgresql://...'. Accept both without exposing it.
command = re.fullmatch(r"psql\s+(?:--dbname(?:=|\s+))?(['\"])(.+)\1", raw, re.S)
url = command.group(2).strip() if command else raw.strip('"').strip("'")

if any(char in url for char in ('\n', '\r', '\t', ' ')):
    built = pooler_uri()
    if built:
        print(f"::warning::{var_name} contains whitespace; using the assembled Session pooler URI instead.")
        emit(built, f"aws-0-{fb_region}.pooler.supabase.com",
             " [assembled from project ref + password]")
    print(
        f"::error::{var_name} contains whitespace inside the database URI. "
        "Save only the Session pooler URI on one line (the psql wrapper is also accepted).",
        file=sys.stderr,
    )
    sys.exit(1)

m = re.fullmatch(
    r'(postgres(?:ql)?)://([^:/@]+)(?::(.*))?@([^/@?:]+)(?::([0-9]+))?(/[^?]*)?(\?.*)?',
    url,
    re.S,
)
if not m:
    built = pooler_uri()
    if built:
        print(
            f"::warning::{var_name} is not a valid PostgreSQL URI ({shape(url)}); "
            "falling back to the Session pooler URI assembled from the project ref and password."
        )
        emit(built, f"aws-0-{fb_region}.pooler.supabase.com",
             " [assembled from project ref + password]")
    hint = ""
    if not url.startswith(("postgres://", "postgresql://")):
        hint = " The value must begin with postgresql:// (not the Supabase HTTPS project URL)."
    print(
        f"::error::{var_name} is not a valid PostgreSQL connection string. "
        "Expected postgresql://<user>:<password>@<host>:5432/postgres. Copy the URI "
        "from Supabase -> Connect -> Session pooler, and save the complete value in "
        f"the GitHub Actions secret.{hint} Redacted shape of the received value: {shape(url)}",
        file=sys.stderr,
    )
    sys.exit(1)

scheme, user, password, host, port, path, query = m.groups()
password = password or ''
hostport = f"{host}:{port}" if port else host

# Re-encode the password so special characters can't break the URI parser.
password = urllib.parse.quote(urllib.parse.unquote(password), safe='')
user = urllib.parse.quote(urllib.parse.unquote(user), safe='')

safe = f"{scheme}://{user}:{password}@{hostport}{path or '/postgres'}{query or ''}"

if host.startswith('db.') and host.endswith('.supabase.co'):
    built = pooler_uri()
    if built:
        print(f"::warning::{var_name} uses the IPv6-only direct host; using the assembled Session pooler URI instead.")
        emit(built, f"aws-0-{fb_region}.pooler.supabase.com",
             " [assembled from project ref + password]")
    print(
        f"::error::{var_name} uses Supabase's IPv6-only direct host ({host}). "
        "Use the Session pooler connection string (port 5432) instead.",
        file=sys.stderr,
    )
    sys.exit(1)

emit(safe, host)
PY
