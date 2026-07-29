// BBQS public REST API — feature 009 (one data truth: live KG, anon).
//
// Reads the LIVE KG via the shared anon layer (_shared/kg.ts) and answers via the single
// RAG path (_shared/rag.ts). No YAML, no MARR_PROJECTS, no service role, no /ontology.
// Public consortium data only (anon); RLS is the authority.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  checkRateLimit,
  rateLimitResponse,
  getClientIP,
  PUBLIC_API_RATE_LIMIT,
} from "../_shared/security.ts";
import { searchProjects, getProject, listSpecies, type KgAuth } from "../_shared/kg.ts";
import { askKG } from "../_shared/rag.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Public surface → anon (RLS authority). Auth is a parameter so a per-user token can be
// wired later (Phase 5) without changing the read layer.
const AUTH: KgAuth = { anon: true };

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Per-IP rate limiting for the public API.
  const clientIP = getClientIP(req);
  const rl = checkRateLimit(`bbqs-api:${clientIP}`, PUBLIC_API_RATE_LIMIT);
  if (!rl.allowed) return rateLimitResponse(corsHeaders, rl.retryAfterMs);

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/bbqs-api\/?/, "").replace(/\/$/, "");

  try {
    // ─── GET /projects ?species= &pi= &q= ───────────────────
    if (req.method === "GET" && (path === "projects" || path === "")) {
      const result = await searchProjects(
        {
          species: url.searchParams.get("species") ?? undefined,
          pi: url.searchParams.get("pi") ?? undefined,
          query: url.searchParams.get("q") ?? undefined,
        },
        AUTH,
      );
      return jsonResponse(result);
    }

    // ─── GET /projects/:grant_number ─────────────────────────
    if (req.method === "GET" && path.startsWith("projects/")) {
      const grantNumber = decodeURIComponent(path.replace("projects/", ""));
      const project = await getProject(grantNumber, AUTH);
      if (!project) return jsonResponse({ error: "Project not found" }, 404);
      return jsonResponse(project);
    }

    // ─── GET /species ────────────────────────────────────────
    if (req.method === "GET" && path === "species") {
      return jsonResponse(await listSpecies(AUTH));
    }

    // ─── POST /ask (public/anon RAG) ─────────────────────────
    if (req.method === "POST" && path === "ask") {
      const body = await req.json().catch(() => ({}));
      const question = body.question || body.message;
      if (!question || typeof question !== "string") {
        return jsonResponse({ error: "Missing 'question' field in request body" }, 400);
      }
      if (question.length > 2000) {
        return jsonResponse({ error: "Question too long (max 2000 characters)" }, 400);
      }
      const result = await askKG(question, AUTH);
      return jsonResponse({ ...result, model: "google/gemini-2.5-flash" });
    }

    // ─── 404 ─────────────────────────────────────────────────
    return jsonResponse(
      {
        error: "Not found",
        availableEndpoints: [
          "GET  /projects",
          "GET  /projects/:grant_number",
          "GET  /species",
          "POST /ask",
        ],
      },
      404,
    );
  } catch (error) {
    console.error("BBQS API error:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Internal server error" },
      500,
    );
  }
});
