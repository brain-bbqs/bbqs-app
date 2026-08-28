import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// --- CORS ---

const ALLOWED_ORIGINS = [
  "https://brain-bbqs.org",
  "https://www.brain-bbqs.org",
  "https://brain-bbqs.github.io",
  "https://bbqs-app.lovable.app",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://localhost:3000",
];

// Also allow any *.lovable.app preview domain
function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.lovable\.app$/.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.lovableproject\.com$/.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.sandbox\.lovable\.dev$/.test(origin)) return true;
  if (origin.startsWith("http://localhost:")) return true;
  return false;
}

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowed = isAllowedOrigin(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
  };
}

// Legacy compat — some functions still use `corsHeaders` directly
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// --- Auth helpers ---

interface AuthResult {
  user: any;
  error?: Response;
}

/**
 * Validates the JWT from the Authorization header.
 * Returns { user } on success, or { user: null, error: Response } on failure.
 */
export async function requireAuth(
  req: Request,
  headers: Record<string, string>,
): Promise<AuthResult> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return {
      user: null,
      error: new Response(
        JSON.stringify({ error: "Authorization header required" }),
        { status: 401, headers: { ...headers, "Content-Type": "application/json" } },
      ),
    };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const {
    data: { user },
    error,
  } = await client.auth.getUser();

  if (error || !user) {
    return {
      user: null,
      error: new Response(
        JSON.stringify({ error: "Invalid or expired token" }),
        { status: 401, headers: { ...headers, "Content-Type": "application/json" } },
      ),
    };
  }

  return { user };
}

/**
 * Validates JWT and checks the user is an admin (MIT email or in ADMIN_EMAILS).
 */
export async function requireAdmin(
  req: Request,
  headers: Record<string, string>,
): Promise<AuthResult> {
  const result = await requireAuth(req, headers);
  if (result.error) return result;

  const email = result.user.email?.toLowerCase() || "";
  const adminEmails = (Deno.env.get("ADMIN_EMAILS") || "")
    .split(",")
    .map((e: string) => e.trim().toLowerCase())
    .filter(Boolean);

  const isMitUser = email.endsWith("@mit.edu");
  const isExplicitAdmin = adminEmails.includes(email);

  if (!isMitUser && !isExplicitAdmin) {
    return {
      user: null,
      error: new Response(
        JSON.stringify({ error: "Admin access required" }),
        { status: 403, headers: { ...headers, "Content-Type": "application/json" } },
      ),
    };
  }

  return result;
}
