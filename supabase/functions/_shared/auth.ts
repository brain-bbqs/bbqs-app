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

/** The caller's roles from user_roles, read under their own JWT (RLS lets a user read their own). */
async function callerRoles(authHeader: string, userId: string): Promise<string[]> {
  const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data } = await client.from("user_roles").select("role").eq("user_id", userId);
  return (data ?? []).map((r: { role: string }) => r.role);
}

/**
 * Validates JWT and checks the user holds the admin role (or is listed in ADMIN_EMAILS). An email
 * domain is not an authority: sign-in is open to whole institutions.
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

  const isAdmin = adminEmails.includes(email) ||
    (await callerRoles(req.headers.get("Authorization")!, result.user.id)).includes("admin");

  if (!isAdmin) {
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

export function bearerOf(req: Request): string {
  return (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

/** The role claim, unverified. Only ever used to skip asking the platform about a token that
 *  cannot be the service role; it never grants anything. */
function unverifiedRole(token: string): string | null {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4))).role ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether `bearer` is this project's service-role credential, as the platform decides: only the
 * service role may list auth users. The injected SUPABASE_SERVICE_ROLE_KEY is one such credential
 * but not the only one — on this project it is not the key the dashboard shows and the vault holds,
 * so byte equality alone refused every cron and DB-trigger call (2026-11-04;
 * tests/guards/service-role-check).
 */
export async function isServiceRole(bearer: string): Promise<boolean> {
  if (!bearer) return false;
  if (bearer === (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")) return true;
  const secretKey = bearer.startsWith("sb_secret_");
  if (!secretKey && unverifiedRole(bearer) !== "service_role") return false;
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/admin/users?page=1&per_page=1`, {
    headers: secretKey ? { apikey: bearer } : { apikey: bearer, Authorization: `Bearer ${bearer}` },
  });
  await res.body?.cancel();
  return res.ok;
}

/**
 * For functions that act on the consortium's behalf (send email, write the KG): the service-role key
 * (cron and DB triggers via cron_invoke) or a signed-in admin/curator. Returns the rejection to send,
 * or null to proceed. The public anon key is rejected — it ships in every browser bundle.
 */
export async function requireCuratorOrService(
  req: Request,
  headers: Record<string, string>,
): Promise<Response | null> {
  const authHeader = req.headers.get("Authorization") || "";
  if (await isServiceRole(bearerOf(req))) return null;

  const deny = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), { status, headers: { ...headers, "Content-Type": "application/json" } });
  const result = await requireAuth(req, headers);
  if (result.error) return result.error;
  const roles = await callerRoles(authHeader, result.user.id);
  return roles.includes("admin") || roles.includes("curator") ? null : deny(403, "Admin or curator only");
}

/** For functions only cron or the database call: the service-role key, nothing else. */
export async function requireService(req: Request, headers: Record<string, string>): Promise<Response | null> {
  if (await isServiceRole(bearerOf(req))) return null;
  return new Response(JSON.stringify({ error: "Service role only" }), {
    status: 401, headers: { ...headers, "Content-Type": "application/json" },
  });
}

/** Escape text interpolated into an HTML email. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
