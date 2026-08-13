export function supabaseAnonymousHeaders(rawKey: string): Record<string, string> {
  const key = rawKey.trim();
  // PostgREST expects the API key in the 'apikey' header. 
  // If the key is a JWT (legacy), it also acts as a Bearer token.
  // Newer sb_publishable keys are NOT JWTs and should ONLY be in the 'apikey' header.
  const headers: Record<string, string> = { apikey: key };
  return headers;
}
