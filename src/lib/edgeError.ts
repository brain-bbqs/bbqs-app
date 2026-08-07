// Extract the REAL error from a supabase.functions.invoke result. On a non-2xx the
// client returns a FunctionsHttpError whose `.context` is the raw Response — the actual
// { error } body lives there, not in `data`. Without this, callers only see a generic
// message and the true cause (e.g. "RESEND_API_KEY not configured") is hidden.
export async function edgeError(error: unknown, data: unknown): Promise<string> {
  const d = data as { error?: unknown } | null;
  if (d && d.error) return String(d.error);
  const ctx = (error as { context?: { text?: () => Promise<string> } })?.context;
  if (ctx && typeof ctx.text === "function") {
    try {
      const body = await ctx.text();
      try {
        const j = JSON.parse(body);
        if (j?.error) return String(j.error);
      } catch {
        if (body) return body.slice(0, 300);
      }
    } catch {
      /* ignore */
    }
  }
  return (error as { message?: string })?.message || "request failed";
}
