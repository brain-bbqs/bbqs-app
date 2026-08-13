#!/usr/bin/env bash
set -euo pipefail

project_ref="${SANDBOX_PROJECT_REF:-vzfsndsqveacpefoqwsu}"
project_url="https://${project_ref}.supabase.co"
key="${SANDBOX_API_KEY_FALLBACK:-}"

# Prefer the key currently registered to the target project. This prevents an
# old repository secret (or a key copied from production) from grading the
# sandbox with repeated, misleading 401 responses.
if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  response=$(curl -fsS \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    "https://api.supabase.com/v1/projects/${project_ref}/api-keys")
  managed_key=$(printf '%s' "$response" | jq -r '
    ([.[] | select(.type == "publishable")] + [.[] | select(.name == "anon")])
    | .[0].api_key // empty
  ')
  if [ -n "$managed_key" ]; then
    key="$managed_key"
  fi
fi

key=$(printf '%s' "$key" | tr -d '\r\n' | xargs)
if [ -z "$key" ]; then
  echo "::error::Could not resolve a sandbox publishable/anon key. Set SUPABASE_ACCESS_TOKEN or SANDBOX_SUPABASE_ANON_KEY."
  exit 1
fi

echo "::add-mask::$key"
status=$(curl -sS -o /tmp/sandbox-auth-settings.json -w '%{http_code}' \
  -H "apikey: ${key}" \
  "${project_url}/auth/v1/settings")
if [ "$status" -ge 400 ]; then
  echo "::error::The resolved API key was rejected by sandbox project ${project_ref} (Auth settings status ${status})."
  exit 1
fi

echo "SANDBOX_API_KEY=$key" >> "$GITHUB_ENV"
echo "SANDBOX_SUPABASE_URL=$project_url" >> "$GITHUB_ENV"
echo "Verified the API key against sandbox project ${project_ref}."