export function supabaseAnonymousHeaders(rawKey: string): Record<string, string> {
  const key = rawKey.trim();
  const headers: Record<string, string> = { apikey: key };

  // Legacy anon keys are JWTs and may be used as a Bearer token. Supabase's
  // newer sb_publishable_* keys are API keys, not JWTs; sending one as Bearer
  // causes an otherwise valid anonymous REST request to return 401.
  if (key.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${key}`;
  }

  return headers;
}