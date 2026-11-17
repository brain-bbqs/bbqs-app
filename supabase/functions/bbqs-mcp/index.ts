import { McpServer, StreamableHttpTransport } from "npm:mcp-lite@^0.10.0";
import { Hono } from "npm:hono@^4.9.7";
import { searchProjects, listSpecies } from "../_shared/kg.ts";
import { askKG } from "../_shared/rag.ts";
import { awardKey, fonKey, nihAwardCore } from "../_shared/identity-keys.ts";
import {
  decideFundingCall, decideResource, isUniqueViolation, matchOrganizations, uniqueViolationText, violatedConstraint,
  type CallRow, type OrgRow, type ResourceRow,
} from "../_shared/kg-write.ts";

// BBQS MCP — one endpoint, three tiers, gated by step-up OAuth.
//
// Anyone may connect and use the PUBLIC tools with no account. The moment a caller invokes a tool
// that writes or reveals more, the server answers 401 with a WWW-Authenticate challenge and the
// client runs the OAuth flow (Supabase is the authorization server; the user approves at
// /oauth/consent). This is the MCP spec's step-up authorization flow: authorize when a capability
// is reached for, not at connection time. It is why there is no second server — the split that once
// justified one was anon-vs-write, and OAuth turns that into a per-tool gate on a single surface.
//
// EVERY AUTHENTICATED TOOL ACTS AS THE CALLER. Their Supabase JWT is forwarded verbatim to
// PostgREST and to the edge functions, so RLS applies, SECURITY DEFINER RPCs see a real auth.uid(),
// and data_audit_log names a person. No service-role key is held here — and could not drive these
// RPCs even if it were, since they gate on auth.uid().
//
// Deploy: supabase functions deploy bbqs-mcp --project-ref vpexxhfpvghlejljwpvt
// See docs/onboarding-a-new-award.md for the onboarding sequence the curator tools implement.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANON = { anon: true } as const;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, mcp-session-id, mcp-protocol-version",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
  // A browser client cannot read the challenge, so cannot start the OAuth handshake, unless
  // WWW-Authenticate is exposed.
  "Access-Control-Expose-Headers": "mcp-session-id, WWW-Authenticate",
};

// ── OAuth 2.1 resource-server plumbing (MCP authorization spec) ──
// Supabase Auth is the authorization server; this function is only the resource server. RFC 9728
// wants protected-resource metadata at the host root, which we cannot serve on supabase.co, so it
// lives under the function and is named in every challenge — clients MUST use the URL from the
// header, so this is well-defined.
const BASE = `${SUPABASE_URL}/functions/v1/bbqs-mcp`;
const RESOURCE = `${BASE}/mcp`;
const RESOURCE_METADATA = `${BASE}/.well-known/oauth-protected-resource`;

function challenge(extra?: Record<string, string>) {
  const parts = [`Bearer resource_metadata="${RESOURCE_METADATA}"`];
  for (const [k, v] of Object.entries(extra ?? {})) parts.push(`${k}="${v}"`);
  return { ...CORS, "WWW-Authenticate": parts.join(", ") };
}

// ── Tiers ───────────────────────────────────────────────────
// A tool's tier is the authority the STEP-UP GATE below demands before the transport ever runs it.
// PUBLIC runs anonymously; MEMBER needs any signed-in consortium member; CURATOR needs admin/curator.
const PUBLIC_TOOLS = new Set(["search_projects", "list_species", "ask_bbqs", "list_funding_opportunities"]);
const MEMBER_TOOLS = new Set(["whoami", "my_onboarding_status", "update_my_profile", "request_working_groups"]);
const CURATOR_TOOLS = new Set([
  "onboarding_status", "recent_onboardings", "find_person", "whois", "list_admins", "kg_query",
  "onboard_member", "sync_member_groups", "group_audit", "send_welcome_email", "slack_channels",
  "set_onboarding_step", "offboard_member", "add_funding_opportunity", "refresh_grant_from_reporter",
  "create_grant", "repoint_grant", "detect_grant_renumbers", "confirm_species_candidate",
  "add_resource", "set_suggestion_status", "import_questionnaire_response", "onboarding_digest",
  "revoke_role", "set_dandiset_hidden",
]);

type Caller = { id: string; email: string; roles: string[]; isCurator: boolean };

// Compact, not pretty-printed: indentation is pure token cost on every result.
const text = (v: unknown) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }],
});

/** Normalise a tool argument that should be an array. An MCP client may hand an array parameter over
 *  as a real array, a JSON string ('["a","b"]'), or a comma string ("a, b") — the last two, sent
 *  straight to a Postgres array/jsonb column, error. This makes the column write independent of how
 *  the client serialised it. `json:true` keeps parsed objects (for jsonb columns like due_dates);
 *  otherwise every element is coerced to a string (for text[] columns). */
function coerceArray(v: unknown, json = false): unknown[] {
  let arr: unknown[];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    if (s.startsWith("[")) {
      try { const p = JSON.parse(s); arr = Array.isArray(p) ? p : [p]; }
      catch { arr = s.split(",").map((x) => x.trim()).filter(Boolean); }
    } else {
      arr = s.split(",").map((x) => x.trim()).filter(Boolean);
    }
  } else {
    return v == null ? [] : [v];
  }
  return json ? arr : arr.map((x) => (typeof x === "string" ? x : String(x)));
}

/** PostgREST under the caller's identity. RLS decides what comes back. clientTag, when given, sets
 *  x-bbqs-client — which current_actor_via() reads, so a write is stamped "bbqs-mcp:<email>" in the
 *  audit log instead of the generic "authenticated-user". PostgREST exposes it via request.headers,
 *  and it reaches the log_data_change trigger inside the SECURITY DEFINER RPCs it calls. */
async function rest(jwt: string, pathAndQuery: string, init?: RequestInit, clientTag?: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json",
      ...(clientTag ? { "x-bbqs-client": clientTag } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : null;
}

const rpc = (jwt: string, fn: string, args: unknown, clientTag?: string) =>
  rest(jwt, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, clientTag);

/** A grant number as the KG writes it: the NIH core ('1U01MH143789-01' -> 'U01MH143789'), else as
 *  typed. The core is what uq_grants_award_key compares, and a valid RePORTER search key. */
function grantNumberFor(v: unknown): string {
  const s = String(v ?? "").trim();
  return nihAwardCore(s) ?? s;
}

/** Another edge function, still as the caller — which is what makes auth.uid() resolve there. */
async function callFunction(jwt: string, name: string, body: unknown) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const raw = await res.text();
  let parsed: unknown = raw;
  try { parsed = JSON.parse(raw); } catch { /* keep the text */ }
  if (!res.ok) throw new Error(`${name}: ${res.status} ${raw.slice(0, 400)}`);
  return parsed;
}

/** Who is calling, and may they curate? Read from the token, never from tool arguments. A token not
 *  issued by this project resolves to nobody, which is also how invalid tokens are rejected. */
async function resolveCaller(jwt: string): Promise<Caller | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) return null;
  const user = await res.json() as { id?: string; email?: string };
  if (!user?.id) return null;
  const roles = await rest(jwt, `user_roles?select=role&user_id=eq.${user.id}`).catch(() => []);
  const names = (roles ?? []).map((r: { role: string }) => r.role);
  return { id: user.id, email: user.email ?? "", roles: names,
           isCurator: names.includes("admin") || names.includes("curator") };
}

/** The highest authority any tools/call in this request demands. Non-call messages (initialize,
 *  tools/list, notifications) are public, so an anonymous client can always discover the surface. */
function requiredTier(bodyText: string): "public" | "member" | "curator" {
  let msgs: Array<{ method?: string; params?: { name?: string } }>;
  try {
    const parsed = JSON.parse(bodyText);
    msgs = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return "public"; // let the transport reject malformed JSON-RPC
  }
  let tier: "public" | "member" | "curator" = "public";
  for (const m of msgs) {
    if (m?.method !== "tools/call") continue;
    const name = m?.params?.name ?? "";
    if (CURATOR_TOOLS.has(name)) return "curator";
    if (MEMBER_TOOLS.has(name)) tier = "member";
  }
  return tier;
}

// Served by Pages from public/brand/. PNG first: the MCP spec requires clients that show icons to
// support PNG, while SVG support is optional.
const ICONS = [
  { src: "https://brain-bbqs.org/brand/bbqs-mcp-icon-256.png", mimeType: "image/png", sizes: ["256x256"] },
  { src: "https://brain-bbqs.org/brand/bbqs-mcp-icon-512.png", mimeType: "image/png", sizes: ["512x512"] },
  { src: "https://brain-bbqs.org/brand/bbqs-mcp-icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
];

const tierOf = (n: string): "public" | "member" | "curator" =>
  CURATOR_TOOLS.has(n) ? "curator" : MEMBER_TOOLS.has(n) ? "member" : "public";

/** The tools/call and initialize messages in a JSON-RPC body (one message or a batch). */
function rpcMessages(bodyText: string): Array<{ method: string; params?: { name?: string; arguments?: unknown; clientInfo?: { name?: string; version?: string } } }> {
  try {
    const parsed = JSON.parse(bodyText);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter((m) => m?.method === "tools/call" || m?.method === "initialize");
  } catch {
    return [];
  }
}

type RequestMeta = { userAgent: string | null; sessionId: string | null };
type CallLog = {
  tool: string; tier: string; outcome: "ok" | "error" | "refused"; error?: string | null;
  durationMs?: number | null; args?: unknown; method?: string; clientName?: string | null;
};

/** One row in mcp_usage_log. Sent under the caller's JWT so the row names them, or the anon key when
 *  there is none. Best-effort: a logging failure never touches the call. Until migration
 *  20261104120000 is applied log_mcp_usage knows only the first five parameters, so fall back. */
async function logCall(jwt: string, meta: RequestMeta, e: CallLog, clientTag?: string) {
  const token = jwt || ANON_KEY;
  const base = { _tool: e.tool, _tier: e.tier, _ok: e.outcome === "ok", _error: e.error ?? null, _duration_ms: e.durationMs ?? null };
  try {
    await rpc(token, "log_mcp_usage", {
      ...base, _outcome: e.outcome, _args: e.args ?? null, _method: e.method ?? "tools/call",
      _client_name: e.clientName ?? null, _user_agent: meta.userAgent, _session_id: meta.sessionId,
    }, clientTag);
  } catch {
    try { await rpc(token, "log_mcp_usage", base, clientTag); } catch { /* best-effort */ }
  }
}

function buildServer(jwt: string, caller: Caller | null, meta: RequestMeta) {
  const mcp = new McpServer({ name: "bbqs-mcp", version: "3.6.0" });
  // mcp-lite 0.10 builds serverInfo from name and version only and returns that same object in the
  // initialize result, so the spec's display fields (title, websiteUrl, icons) are set on it here.
  const serverInfo = (mcp as unknown as { serverInfo?: Record<string, unknown> }).serverInfo;
  if (serverInfo) Object.assign(serverInfo, { title: "BBQS", websiteUrl: "https://brain-bbqs.org", icons: ICONS });
  const obj = (properties: Record<string, unknown>, required?: string[]) =>
    ({ type: "object" as const, properties, ...(required ? { required } : {}) });

  // Stamp authenticated writes as bbqs-mcp:<email> so the audit log shows the surface AND the user,
  // not the generic "authenticated-user". Reads carry it too (harmless — only writes are logged).
  const _clientTag = caller ? `bbqs-mcp:${caller.email}` : "bbqs-mcp";
  const restC = (path: string, init?: RequestInit) => rest(jwt, path, init, _clientTag);
  const rpcC = (fn: string, args: unknown) => rpc(jwt, fn, args, _clientTag);
  /** Every row a read returns, page by page (PostgREST caps one response at its max_rows): what a
   *  write path folds the identity keys over before it writes (_shared/kg-write.ts). */
  const restAllC = async (path: string): Promise<any[]> => {
    const out: any[] = [];
    for (let offset = 0, pages = 0; pages < 50; pages++) {
      const page = await restC(`${path}&order=id&limit=1000&offset=${offset}`);
      if (!Array.isArray(page) || !page.length) break;
      out.push(...page);
      offset += page.length;
    }
    return out;
  };
  /** An RPC whose write a unique index may refuse (the uq_* identity keys, 20261117181500): a 23505
   *  is said as what it is, every other error is thrown as it came. */
  const keyedRpcC = async (fn: string, args: unknown, refused: string) => {
    try {
      return await rpcC(fn, args);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      throw new Error(`${refused} (${uniqueViolationText(e)}), under another spelling or written in the meantime. Nothing was written.`);
    }
  };

  // Register every tool through T: a thrown error becomes a returned isError result carrying the
  // REAL message. Without it mcp-lite flattens a PostgREST error ("duplicate key", "malformed
  // array") into a bare "Internal error", which sends the model into a blind, multi-call diagnostic
  // spiral — the most expensive kind of round-trip. T also logs every call (reads included) to
  // mcp_usage_log via log_mcp_usage, for the admin usage panel — fired in finally and swallowed, so a
  // logging failure never touches the tool result. It awaits (edge functions kill un-awaited work).
  const T = (name: string, def: { description: string; parameters: unknown; handler: (a: any) => Promise<unknown> }) =>
    mcp.tool(name, {
      description: def.description,
      parameters: def.parameters as any,
      handler: async (a: any) => {
        const t0 = Date.now();
        let ok = true;
        let errMsg: string | null = null;
        try { return await def.handler(a); }
        catch (e) {
          ok = false; errMsg = e instanceof Error ? e.message : String(e);
          return { content: [{ type: "text" as const, text: `Error: ${errMsg}` }], isError: true };
        } finally {
          await logCall(jwt, meta, {
            tool: name, tier: tierOf(name), outcome: ok ? "ok" : "error", error: errMsg,
            durationMs: Date.now() - t0, args: a,
          }, _clientTag);
        }
      },
    });

  // ── PUBLIC — no account ──────────────────────────────────
  T("search_projects", {
    description: "Search BBQS consortium projects by species, PI name, or free-text query. Public consortium data; no sign-in.",
    parameters: obj({
      species: { type: "string", description: "e.g. Mouse, Zebrafish" },
      pi: { type: "string" },
      query: { type: "string", description: "Free-text semantic search" },
    }),
    handler: async (a: { species?: string; pi?: string; query?: string }) =>
      text(await searchProjects({ species: a.species, pi: a.pi, query: a.query }, ANON)),
  });

  T("list_species", {
    description: "Every species studied across BBQS, with project counts. Public; no sign-in.",
    parameters: obj({}),
    handler: async () => text(await listSpecies(ANON)),
  });

  T("ask_bbqs", {
    description: "Ask a natural-language question about the consortium; answered from the knowledge base. Public; no sign-in.",
    parameters: obj({ question: { type: "string" } }, ["question"]),
    handler: async (a: { question: string }) => {
      const { answer, sources } = await askKG(a.question, ANON);
      const src = sources.length ? sources.map((s) => `[${s.type}] ${s.title}`).join(", ") : "none";
      return text(`${answer}\n\nSources: ${src}`);
    },
  });

  T("list_funding_opportunities", {
    description: "Funding opportunities BBQS tracks (NIH, NSF, etc.) — FON, title, status, dates, URL. Public; no sign-in. Check here before add_funding_opportunity to avoid a duplicate FON.",
    parameters: obj({
      status: { type: "string", description: "Filter by status, e.g. open" },
      limit: { type: "number", description: "default 25, max 100" },
    }),
    handler: async (a: { status?: string; limit?: number }) => {
      const n = Math.min(Math.max(Math.trunc(a.limit ?? 25), 1), 100);
      let q = "funding_opportunities?select=fon,title,status,activity_code,url,posted_date,open_date,expiration_date,due_dates,participating_orgs,relevance_tags&order=posted_date.desc";
      if (a.status) q += `&status=eq.${encodeURIComponent(a.status)}`;
      return text(await rest(ANON_KEY, `${q}&limit=${n}`));
    },
  });

  // ── MEMBER — any signed-in consortium member ─────────────
  T("whoami", {
    description: "[sign-in] Who this session is acting as, and whether they may curate.",
    parameters: obj({}),
    handler: async () => text(caller
      ? { ...caller, note: "Your writes are attributed to this account in data_audit_log." }
      : { signed_in: false }),
  });

  T("my_onboarding_status", {
    description: "[sign-in] Your own onboarding checklist and remaining steps.",
    parameters: obj({}),
    handler: async () => text(await restC( "onboarding_pipeline?select=*")),
  });

  T("update_my_profile", {
    description: "[sign-in] Edit your OWN profile: institution, ORCID, research areas, skills, secondary emails. Cannot set your role or mailing-list groups — use request_working_groups for those. An ORCID iD that is already on another person's record is not saved (one ORCID iD, one person: a curator merges the two records); the other fields still are, and the result names what was not saved.",
    parameters: obj({
      institution: { type: "string" },
      orcid: { type: "string" },
      research_areas: { type: "array", items: { type: "string" } },
      skills: { type: "array", items: { type: "string" } },
      secondary_emails: { type: "array", items: { type: "string" } },
    }),
    handler: async (a: Record<string, unknown>) => {
      const args = {
        _institution: a.institution ?? null, _orcid: a.orcid ?? null,
        _research_areas: a.research_areas ?? null, _skills: a.skills ?? null,
        _secondary_emails: a.secondary_emails ?? null, _requested_working_groups: null,
      };
      try {
        return text(await rpcC("member_self_update", args));
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        // member_self_update writes one row in one statement, so the refusal saved nothing. Of its
        // fields only the ORCID is an identity key (uq_investigators_orcid_key); with _orcid null the
        // RPC keeps the stored ORCID, so the other fields can be saved without it.
        const constraint = violatedConstraint(e);
        if (!/orcid/i.test(uniqueViolationText(e))) {
          throw new Error(`Nothing was saved: the database refused it as a duplicate of another record (${uniqueViolationText(e)}). Ask a curator.`);
        }
        const orcidNotSaved = `The ORCID iD ${a.orcid} is already on another person's record in the KG (${constraint ?? "its ORCID key"}), ` +
          "so it was not saved: one ORCID iD is one person. If that record is you, ask a curator to merge the two records.";
        const others = ["institution", "research_areas", "skills", "secondary_emails"].filter((k) => a[k] != null);
        if (!others.length) throw new Error(`${orcidNotSaved} Nothing else was asked, so nothing was saved.`);
        const saved = await rpcC("member_self_update", { ...args, _orcid: null });
        return text({ ...(saved && typeof saved === "object" ? saved : {}), saved: others, orcid_not_saved: orcidNotSaved });
      }
    },
  });

  T("request_working_groups", {
    description: "[sign-in] Request to join working groups (WG-Analytics, WG-Devices, WG-ELSI, WG-Standards, WG-Cross-Species). This is a REQUEST — a curator approves it before the mailing lists change. You cannot self-subscribe.",
    parameters: obj({ working_groups: { type: "array", items: { type: "string" } } }, ["working_groups"]),
    handler: async (a: { working_groups: string[] }) => text(await rpcC( "member_self_update", {
      _institution: null, _orcid: null, _research_areas: null, _skills: null,
      _secondary_emails: null, _requested_working_groups: coerceArray(a.working_groups),
    })),
  });

  // ── CURATOR — admin/curator only ─────────────────────────
  T("onboarding_status", {
    description: "[curator] People still onboarding: steps done/total, days in flight, stuck flag. NEW teams live here; use group_audit for people who finished and drifted.",
    parameters: obj({
      grant_number: { type: "string" },
      stuck_only: { type: "boolean" },
    }),
    handler: async (a: { grant_number?: string; stuck_only?: boolean }) => {
      let q = "onboarding_pipeline?select=id,name,email,role,steps_done,steps_total,is_stuck,days_since_created,live_grant_count&order=name";
      if (a.stuck_only) q += "&is_stuck=is.true";
      const rows = await restC( q) as Array<Record<string, unknown>>;
      if (!a.grant_number) return text(rows);
      const ids = await restC(
        `grant_investigators?select=investigator_id,grants!inner(grant_number)&grants.grant_number=eq.${encodeURIComponent(a.grant_number)}`) as Array<{ investigator_id: string }>;
      const keep = new Set(ids.map((r) => r.investigator_id));
      return text(rows.filter((r) => keep.has(String(r.id))));
    },
  });

  T("onboarding_digest", {
    description: "[curator] The weekly stuck-onboarding digest: everyone the pipeline flags is_stuck, with days stuck, grants, each open step and the tool that unblocks it. dry_run (default true) returns it without sending. dry_run=false emails it to dcaic-admin@ now, which is OUTWARD-FACING, so confirm with the human first. It also sends itself every Monday.",
    parameters: obj({ dry_run: { type: "boolean", description: "default true: return the digest, do not email it" } }),
    handler: async (a: { dry_run?: boolean }) =>
      text(await callFunction(jwt, "onboarding-stuck-digest", { dry_run: a.dry_run !== false })),
  });

  T("recent_onboardings", {
    description: "[curator] Most recently ADDED people, newest first — the right answer to \"who joined / was last onboarded recently\". Ordered by created_at, NOT onboarding_completed_at (which is null for most and excludes in-flight additions, so it answers a different question).",
    parameters: obj({ limit: { type: "number", description: "default 10, max 50" } }),
    handler: async (a: { limit?: number }) => {
      const n = Math.min(Math.max(Math.trunc(a.limit ?? 10), 1), 50);
      return text(await restC(
        `investigators?select=name,email,created_at,onboarding_completed_at,grant_investigators(role,grants(grant_number))&order=created_at.desc&limit=${n}`));
    },
  });

  T("whois", {
    description: "[admin] Resolve user_id(s)/email(s) to identity (email, roles, linked investigator, last sign-in). Reads auth.users via an admin-gated function — the only way to name an account with no investigator profile. Pass user_ids/emails arrays to resolve many in ONE call. Admin only.",
    parameters: obj({
      user_id: { type: "string" }, email: { type: "string" },
      user_ids: { type: "array", items: { type: "string" }, description: "resolve many at once" },
      emails: { type: "array", items: { type: "string" } },
    }),
    handler: async (a: { user_id?: string; email?: string; user_ids?: unknown; emails?: unknown }) => {
      const ids = coerceArray(a.user_ids) as string[];
      const emails = coerceArray(a.emails) as string[];
      if (a.user_id) ids.push(a.user_id);
      if (a.email) emails.push(a.email);
      const lookups = [
        ...ids.map((id) => rpcC( "admin_lookup_user", { _user_id: id, _email: null })),
        ...emails.map((em) => rpcC( "admin_lookup_user", { _user_id: null, _email: em })),
      ];
      if (lookups.length === 0) throw new Error("Provide user_id/email or user_ids/emails");
      const out = await Promise.all(lookups);
      return text(out.length === 1 ? out[0] : out);
    },
  });

  T("list_admins", {
    description: "[admin] All admins (or curators) with identities in ONE call — resolves every user_id to name/email/investigator. Use this for \"who are the admins\" instead of a query plus a whois per id.",
    parameters: obj({ role: { type: "string", description: "admin (default) or curator" } }),
    handler: async (a: { role?: string }) => {
      const role = a.role === "curator" ? "curator" : "admin";
      const rows = await restC( `user_roles?select=user_id&role=eq.${role}`) as Array<{ user_id: string }>;
      const ids = [...new Set(rows.map((r) => r.user_id))];
      const out = await Promise.all(ids.map((id) => rpcC( "admin_lookup_user", { _user_id: id, _email: null })));
      return text(out);
    },
  });

  T("revoke_role", {
    description: "[admin] Remove a role (admin, curator or member) from an account, by email or user_id. The database lets only admins change roles; refuses to remove the last admin. whois first to confirm the account. Revoke-only by design: granting admin is not an MCP capability. THE tool for \"take admin/curator away from X\" — do not write SQL.",
    parameters: obj({
      email: { type: "string" }, user_id: { type: "string" },
      role: { type: "string", enum: ["admin", "curator", "member"] },
    }, ["role"]),
    handler: async (a: { email?: string; user_id?: string; role: string }) => {
      if (!["admin", "curator", "member"].includes(a.role)) throw new Error("role must be admin, curator or member");
      let uid = a.user_id;
      if (!uid) {
        if (!a.email) throw new Error("Provide email or user_id");
        const who = await rpcC("admin_lookup_user", { _user_id: null, _email: a.email }) as { found?: boolean; user_id?: string };
        if (!who?.found || !who.user_id) throw new Error(`No account for ${a.email}`);
        uid = who.user_id;
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid)) throw new Error("user_id must be a UUID");
      if (a.role === "admin") {
        const admins = await restC("user_roles?select=user_id&role=eq.admin") as Array<{ user_id: string }>;
        if (admins.every((r) => r.user_id === uid)) throw new Error("Refusing to remove the last admin");
      }
      const rows = await restC(`user_roles?user_id=eq.${uid}&role=eq.${a.role}`, {
        method: "DELETE", headers: { Prefer: "return=representation" },
      });
      // RLS turns a forbidden DELETE into zero rows rather than an error.
      if (!Array.isArray(rows) || !rows.length) {
        throw new Error(`Nothing removed: ${a.email ?? uid} does not hold ${a.role}, or this account may not change roles`);
      }
      return text({ removed: rows, note: "Takes effect on the account's next request; an existing session token keeps working until it expires." });
    },
  });

  T("find_person", {
    description: "[curator] Find people by email, name fragment, or grant number. Also searches secondary_emails, where alias duplicates hide. Returns roster roles too (grant role ≠ consortium role, #283).",
    parameters: obj({ query: { type: "string" } }, ["query"]),
    handler: async (a: { query: string }) => {
      const q = a.query.trim();
      const enc = encodeURIComponent(q);
      if (/^[A-Z0-9]+$/i.test(q) && /\d/.test(q)) {
        return text(await restC(
          `grant_investigators?select=role,role_source,investigators(id,name,email,secondary_emails,role,institution),grants!inner(grant_number)&grants.grant_number=eq.${enc}`));
      }
      const like = encodeURIComponent(`*${q}*`);
      return text(await restC(
        `investigators?select=id,name,email,secondary_emails,role,institution,working_groups,onboarding_completed_at,grant_investigators(role,role_source,grants(grant_number))&or=(email.ilike.${like},name.ilike.${like},secondary_emails.cs.{${enc}})`));
    },
  });

  T("kg_query", {
    description: "[curator] Read-only PostgREST escape hatch, run as the caller so RLS applies. e.g. \"grants?select=grant_number,title&limit=5\". For exceptions no fixed tool anticipates. Refuses anything but a read.",
    parameters: obj({ path: { type: "string" } }, ["path"]),
    handler: async (a: { path: string }) => {
      const p = a.path.replace(/^\/+/, "");
      if (/^rpc\//i.test(p)) throw new Error("kg_query is read-only; use the dedicated tools for RPCs.");
      return text(await restC( p));
    },
  });

  T("onboard_member", {
    description: "[curator] Create/update a person and optionally link a grant roster, seeding their checklist. The roster link is load-bearing: pi@ derives from grant_investigators, not the role label. Raises 42P01 if the person has both an emailed record and an email-less name twin — find_person first when unsure.",
    parameters: obj({
      email: { type: "string" }, name: { type: "string" },
      role: { type: "string", description: "contact_pi, co_pi, mpi, co-investigator, postdoc, graduate_student, research_staff" },
      grant_id: { type: "string" },
      working_groups: { type: "array", items: { type: "string" } },
      institution: { type: "string" },
      secondary_emails: { type: "array", items: { type: "string" } },
    }, ["email", "name", "role"]),
    handler: async (a: Record<string, unknown>) => text(await rpcC( "onboard_member", {
      _email: a.email, _name: a.name, _role: a.role, _grant_id: a.grant_id ?? null,
      _working_groups: coerceArray(a.working_groups), _institution: a.institution ?? null,
      _secondary_emails: coerceArray(a.secondary_emails),
    })),
  });

  T("sync_member_groups", {
    description: "[curator] Add a person to the Google Groups their role and working groups entitle them to. Additive; never removes. ONE call covers every group. pi@ is decided from the roster, so link the roster BEFORE this or it adds consortium@ only and still reports success.",
    parameters: obj({
      email: { type: "string" }, role: { type: "string" },
      working_groups: { type: "array", items: { type: "string" } },
    }, ["email"]),
    handler: async (a: { email: string; role?: string; working_groups?: string[] }) =>
      text(await callFunction(jwt, "sync-member-groups", {
        email: a.email, old: { working_groups: [], role: null },
        new: { working_groups: coerceArray(a.working_groups), role: a.role ?? null },
      })),
  });

  T("group_audit", {
    description: "[curator] Diff LIVE Google Group membership against the roster. action=audit writes nothing; action=repair adds the missing, never removes. 'In Google' minus 'Expected' is NOT drift (expected counts primary addresses only). Trust 'missing' and the unentitled list.",
    parameters: obj({ action: { type: "string", enum: ["audit", "repair"] } }),
    handler: async (a: { action?: string }) =>
      text(await callFunction(jwt, "group-audit", { action: a.action === "repair" ? "repair" : "audit" })),
  });

  T("send_welcome_email", {
    description: "[curator] Send the BBQS welcome email to one person. OUTWARD-FACING — confirm with the human first. Groups and Drive should already be done, because the email states they have been. One email per award, contact PI first — see docs/templates/welcome-new-team.md and its standing NIH cc list.",
    parameters: obj({ email: { type: "string" }, name: { type: "string" }, role: { type: "string" } }, ["email", "name"]),
    handler: async (a: { email: string; name: string; role?: string }) =>
      text(await callFunction(jwt, "send-welcome-email", { to: a.email, name: a.name, role: a.role ?? null })),
  });

  T("slack_channels", {
    description: "[curator] action=check reports workspace/channel membership; action=invite adds the configured channels. Workspace ENTRY for an external guest is a manual Slack invite — check first and expect not_in_workspace for new external people.",
    parameters: obj({
      email: { type: "string" }, action: { type: "string", enum: ["check", "invite"] },
      role: { type: "string" }, working_groups: { type: "array", items: { type: "string" } },
    }, ["email"]),
    handler: async (a: { email: string; action?: string; role?: string; working_groups?: string[] }) =>
      text(await callFunction(jwt, "slack-channels", {
        email: a.email, role: a.role ?? null, working_groups: coerceArray(a.working_groups),
        action: a.action === "invite" ? "invite" : "check",
      })),
  });

  T("set_onboarding_step", {
    description: "[curator] Mark one checklist step done/pending/not_started/skipped. Call ONLY after the tool that performs the action succeeded — a step marked done is a claim the outward action happened. Steps: kg_created, grant_link, consortium_group, pi_group, young_investigators_group, wg_groups, welcome_email, data_questionnaire, slack.",
    parameters: obj({
      investigator_id: { type: "string" }, step: { type: "string" },
      status: { type: "string", enum: ["done", "pending", "not_started", "skipped"] },
    }, ["investigator_id", "step", "status"]),
    handler: async (a: { investigator_id: string; step: string; status: string }) =>
      text(await rpcC( "set_onboarding_step", { _investigator_id: a.investigator_id, _step: a.step, _status: a.status })),
  });

  T("offboard_member", {
    description: "[curator] Remove someone from ONE grant, or the consortium when grant_id is omitted. Multi-grant safe: access justified by a remaining award is kept. Returns the groups no longer justified — removing them is a SEPARATE outward-facing step. Never deletes the person.",
    parameters: obj({ investigator_id: { type: "string" }, grant_id: { type: "string" } }, ["investigator_id"]),
    handler: async (a: { investigator_id: string; grant_id?: string }) =>
      text(await rpcC( "offboard_member", { _investigator_id: a.investigator_id, _grant_id: a.grant_id ?? null })),
  });

  T("create_grant", {
    description: "[curator] Create an award that is NOT YET on NIH RePORTER — a funder notice — so a new team can be onboarded before the registry catches up. This is the missing primitive: onboard_member links a person to a grant that must already exist, and refresh_grant_from_reporter is a no-op until RePORTER has the award. Inserts the grant (grant_number, title, and fiscal_year if known), optionally its awardee project row (pass institution), and optionally links an ALREADY-EXISTING contact PI to the roster (role_source funder_notice). Idempotent on the award: an NIH number is reduced to its core (1U01MH143789-01 -> U01MH143789) and an award already in the KG is reused, however it was spelled; likewise an institution already in the KG. Provenance is recorded as funder_notice (G1). It does NOT create people (an unknown contact_pi_email is reported back — use onboard_member) and does NOT touch Google Groups. Sequence for a new team: create_grant → onboard_member(grant_id, …) for each PI/member → sync_member_groups → send_welcome_email → refresh_grant_from_reporter once the award appears on RePORTER (it fills abstract/amount/publications, adds MPIs, and never demotes a role). Do not write SQL for this.",
    parameters: obj({
      grant_number: { type: "string", description: "Award number, e.g. U01MH143789; an NIH number is reduced to its core (prefix digit and -01 year suffix dropped), and matched against the awards already in the KG" },
      title: { type: "string", description: "Award title from the funder notice (required; RePORTER cannot supply it yet)" },
      fiscal_year: { type: "number", description: "Award fiscal year, if known" },
      institution: { type: "string", description: "Awardee institution; when given, creates the project row. An organization already in the KG under another spelling (case, punctuation) is reused." },
      study_human: { type: "boolean", description: "Whether the project studies humans, if known" },
      contact_pi_email: { type: "string", description: "Contact PI. Linked as contact_pi ONLY if this person already exists in the KG; if not found the grant is still created and the result says so — then use onboard_member with the returned grant_id." },
    }, ["grant_number", "title"]),
    handler: async (a: { grant_number: string; title: string; fiscal_year?: number; institution?: string; study_human?: boolean; contact_pi_email?: string }) => {
      // The RPC looks the award up by exact grant_number and the institution by lower(btrim(name)),
      // so hand it the spellings the KG already holds: otherwise a '1U01MH143789-01' or a 'University
      // of X' next to 'UNIVERSITY OF X' becomes a second record (uq_grants_award_key and
      // uq_organizations_name_key refuse it once 20261117181500 is applied).
      const grants = await restAllC("grants?select=id,grant_number") as Array<{ id: string; grant_number: string }>;
      const award = grants.find((g) => awardKey(g.grant_number) === awardKey(a.grant_number))?.grant_number ?? grantNumberFor(a.grant_number);
      let institution = a.institution?.trim() || null;
      if (institution) {
        const orgs = await restAllC("organizations?select=id,name") as OrgRow[];
        institution = matchOrganizations(orgs, institution).row?.name ?? institution;
      }
      return text(await keyedRpcC("create_grant", {
        _grant_number: award, _title: a.title,
        _fiscal_year: a.fiscal_year ?? null, _institution: institution,
        _study_human: a.study_human ?? null, _contact_pi_email: a.contact_pi_email ?? null,
      }, `Not created: the award ${award}${institution ? ` or the institution ${institution}` : ""} is already in the KG`));
    },
  });

  T("import_questionnaire_response", {
    description: "[curator] Record one BBQS Data Questionnaire response on its project (projects.metadata). answers is an object of questionnaire key -> value, keys from src/data/questionnaire-fields.ts (e.g. data_types_collected, use_sensors, primary_storage); an unknown key rejects the whole call. Map the form's answers to keys yourself and store option labels with their '(e.g., ...)' examples trimmed — the convention earlier imports used, so the same answer reads the same across projects. FILL-ONLY-EMPTY: a field that already holds an answer is skipped and reported, never overwritten, so re-running is safe. Each written answer is credited to the respondent at G2 (questionnaire) while the audit log records you as the importer; also sets questionnaire_submitted_by/_at, which the questionnaire status view judges against the roster. THE tool for 'import/update the questionnaire answers for grant X' — do not write SQL. Then mark the contact PI's data_questionnaire step done with set_onboarding_step.",
    parameters: obj({
      grant_number: { type: "string", description: "Core project number, e.g. U01MH143789" },
      respondent_email: { type: "string", description: "The address the respondent entered on the form" },
      answers: { type: "object", description: "questionnaire key -> value (string, array of strings, or boolean)" },
      submitted_at: { type: "string", description: "Form timestamp, ISO 8601 with offset, e.g. 2026-10-27T16:07:35-04:00" },
      response_id: { type: "string", description: "Forms responseId if known; makes a re-import of the same response a no-op" },
    }, ["grant_number", "respondent_email", "answers"]),
    handler: async (a: { grant_number: string; respondent_email: string; answers: unknown; submitted_at?: string; response_id?: string }) => {
      // A client may serialise the object parameter as a JSON string.
      const answers = typeof a.answers === "string" ? JSON.parse(a.answers) : a.answers;
      return text(await rpcC("import_questionnaire_response", {
        _grant_number: a.grant_number, _respondent_email: a.respondent_email, _answers: answers,
        _submitted_at: a.submitted_at ?? null, _response_id: a.response_id ?? null,
      }));
    },
  });

  T("refresh_grant_from_reporter", {
    description: "[curator] Pull the latest NIH RePORTER data for a grant and fill the KG — abstract, award amount, nih_link, reporter_project_num, publications. Use this when a grant is newly on RePORTER or its registry data changed (e.g. a funder-notice grant that was pre-registry). Omit grant_number to refresh every grant. Does not demote roster roles. This is the tool for \"fix the RePORTER data for grant X\" — do not write SQL.",
    parameters: obj({ grant_number: { type: "string", description: "e.g. R61MH142354 (any NIH spelling, such as 1R61MH142354-01, is reduced to its core); omit to refresh all" } }),
    handler: async (a: { grant_number?: string }) => {
      const q = a.grant_number ? `?action=refresh&grant=${encodeURIComponent(grantNumberFor(a.grant_number))}` : "?action=refresh";
      return text(await callFunction(jwt, `nih-grants${q}`, {}));
    },
  });

  T("repoint_grant", {
    description: "[curator] Repoint a grant to a NEW award number after it was renumbered — e.g. an NIH administering-IC transfer that mints a new core number (U24MH136628 -> U24DA064429). Updates the grant + its project rows + nih_link and records provenance; the old number stays in the audit history. THE tool for \"the grant number changed / it moved to a different IC\" — do not write SQL. Either number may be given in any NIH spelling (1U24MH136628-01): the old one is matched to the grant in the KG, the new one is stored as its core. Refuses if another grant already holds the new award. Follow with refresh_grant_from_reporter for the new number to fill current-year metadata and publications.",
    parameters: obj({
      grant_number: { type: "string", description: "current number in the KG, e.g. U24MH136628" },
      new_grant_number: { type: "string", description: "the award's current/correct number, e.g. U24DA064429" },
      reporter_project_num: { type: "string", description: "optional full per-year string e.g. 5U24DA064429-03; else left for refresh" },
    }, ["grant_number", "new_grant_number"]),
    handler: async (a: { grant_number: string; new_grant_number: string; reporter_project_num?: string }) => {
      // The RPC compares grant_number exactly, so find the stored spelling by the award key, and refuse
      // here a new number another grant already holds under another spelling: the RPC's exact check
      // would let that through and make one award two grants.
      const grants = await restAllC("grants?select=id,grant_number") as Array<{ id: string; grant_number: string }>;
      const current = grants.filter((g) => awardKey(g.grant_number) === awardKey(a.grant_number));
      if (current.length > 1) {
        throw new Error(`${current.map((g) => g.grant_number).join(" and ")} are one award recorded twice: merge them before repointing. Nothing was written.`);
      }
      const target = grantNumberFor(a.new_grant_number);
      const taken = grants.find((g) => awardKey(g.grant_number) === awardKey(target) && g.id !== current[0]?.id);
      if (taken) {
        throw new Error(`Another grant already holds ${target} (as ${taken.grant_number}); repoint would make one award two grants. Nothing was written.`);
      }
      return text(await keyedRpcC("repoint_grant", {
        _grant_number: current[0]?.grant_number ?? a.grant_number,
        _new_grant_number: target,
        _reporter_project_num: a.reporter_project_num ?? null,
      }, `Not repointed: another grant or project already holds ${target}`));
    },
  });

  T("confirm_species_candidate", {
    description: "[curator] Confirm a project's species from its species candidates -- for a project whose study_species holds a category or placeholder ('Rodents', 'Freely moving animals'). Each candidate comes from the grant abstract with the quote that supports it (the species_candidates table; list_species shows them). Writes projects.study_species and records provenance in your name with that quote. replace=false ADDS the species, for a project that studies more than one (predator and prey; flies and fish). THE tool for \"set this project's species\" -- do not write SQL.",
    parameters: obj({
      grant_number: { type: "string", description: "core grant number, e.g. R34DA059512" },
      candidate: { type: "string", description: "the candidate exactly as listed, e.g. Mus musculus" },
      replace: { type: "boolean", description: "true (default) replaces study_species; false adds to it" },
    }, ["grant_number", "candidate"]),
    handler: async (a: { grant_number: string; candidate: string; replace?: boolean | string }) =>
      text(await rpcC("confirm_species_candidate", {
        _grant_number: a.grant_number,
        _candidate: a.candidate,
        // MCP clients sometimes send booleans as strings; only an explicit false adds instead of replacing.
        _replace: !(a.replace === false || a.replace === "false"),
      })),
  });

  T("detect_grant_renumbers", {
    description: "[curator] Find grants that silently froze because the award was RENUMBERED — e.g. an NIH administering-IC transfer that mints a new core number (#385). Cross-checks RePORTER: for each grant whose latest fiscal year is stale (2+ years behind), it looks for the same title/PI under a NEWER, DIFFERENT number and reports it as a probable renumber, with the exact repoint_grant call to run. REPORT ONLY — review each candidate and run repoint_grant to confirm. Good to run periodically or when a grant looks out of date.",
    parameters: obj({ stale_years: { type: "number", description: "flag grants whose latest RePORTER year is this many years behind (default 2)" } }),
    handler: async (a: { stale_years?: number }) => {
      const q = a.stale_years ? `?action=detect-renumbers&stale_years=${a.stale_years}` : "?action=detect-renumbers";
      return text(await callFunction(jwt, `nih-grants${q}`, {}));
    },
  });

  T("set_suggestion_status", {
    description: "[curator] Set the open/closed status of Suggest-a-Feature entries, by their GitHub issue number. The /suggest-feature page shows this stored status whenever it can't get the issue's live state from GitHub, so set it to match the issue after closing or reopening one. THE tool for \"mark these suggestions closed\" — do not write SQL.",
    parameters: obj({
      issue_numbers: { type: "array", items: { type: "number" }, description: "GitHub issue numbers, e.g. [194, 195]" },
      status: { type: "string", enum: ["open", "closed"] },
    }, ["issue_numbers", "status"]),
    handler: async (a: { issue_numbers: unknown; status: string }) => {
      const nums = coerceArray(a.issue_numbers).map(Number).filter(Number.isInteger);
      if (!nums.length) throw new Error("issue_numbers must contain at least one issue number");
      if (a.status !== "open" && a.status !== "closed") throw new Error("status must be open or closed");
      return text(await restC(
        `feature_suggestions?github_issue_number=in.(${nums.join(",")})&select=github_issue_number,title,status`,
        { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: a.status }) },
      ));
    },
  });

  T("set_dandiset_hidden", {
    description: "[curator] Hide or unhide EMBER dandisets, by dandiset id. A hidden dandiset stays in the mirror (dandisets) but loses its resources row, so it leaves the Resources page, search and the knowledge graph, and the nightly ember-dandiset-sync will not recreate it. Use it for test uploads, smoke tests and placeholders. Unhiding recreates the resource at once. A reason is required to hide. THE tool for \"take these datasets off the Resources page\" — do not write SQL.",
    parameters: obj({
      dandiset_ids: { type: "array", items: { type: "string" }, description: "six-digit EMBER ids, e.g. ['000559', '000560']" },
      hidden: { type: "boolean", description: "true (default) hides; false unhides" },
      reason: { type: "string", description: "why, e.g. 'IDP integration test upload'; required to hide" },
    }, ["dandiset_ids"]),
    handler: async (a: { dandiset_ids: unknown; hidden?: boolean | string; reason?: string }) => {
      const ids = coerceArray(a.dandiset_ids).map((x) => String(x).trim()).filter(Boolean);
      if (!ids.length) throw new Error("dandiset_ids must contain at least one id");
      const bad = ids.filter((x) => !/^\d{6}$/.test(x));
      if (bad.length) throw new Error(`Not six-digit dandiset ids: ${bad.join(", ")}`);
      return text(await rpcC("set_dandiset_hidden", {
        _dandiset_ids: ids,
        // Only an explicit false unhides, as with confirm_species_candidate's replace.
        _hidden: !(a.hidden === false || a.hidden === "false"),
        _reason: a.reason ?? null,
        _instance: "ember",
      }));
    },
  });

  T("add_funding_opportunity", {
    description: "[curator] Add/refresh a funding opportunity (NIH/NSF/etc.). fon + title required. A call already in the KG is matched by its FON (case, spaces and dashes aside) and updated with the fields you pass, so re-running fills gaps and never duplicates; it appears on the public Funding page. The FON is the call's identity; its URL is not, because a landing page can list several calls: a URL another call already has is reported in the result's note, never refused. A final notice that replaces its forecast: pass supersedes=<the forecast's FON> and the forecast's row becomes this call in place, its old FON kept in notes. THE tool for \"add this solicitation to funding announcements\" — never fall back to SQL.",
    parameters: obj({
      fon: { type: "string", description: "Funding Opportunity Number, e.g. 'NSF 26-526' or 'RFA-MH-25-xxx'" },
      title: { type: "string" },
      activity_code: { type: "string", description: "e.g. R01, R61, GRFP" },
      status: { type: "string", description: "open | forecasted | expired (default open for a new call; an existing call keeps its status unless one is given)" },
      url: { type: "string" },
      purpose: { type: "string" },
      posted_date: { type: "string", description: "YYYY-MM-DD" },
      open_date: { type: "string", description: "YYYY-MM-DD" },
      expiration_date: { type: "string", description: "YYYY-MM-DD" },
      budget_ceiling: { type: "number" },
      participating_orgs: { type: "array", items: { type: "string" }, description: "e.g. ['NSF']" },
      relevance_tags: { type: "array", items: { type: "string" } },
      due_dates: { type: "array", description: "Array of {date:'YYYY-MM-DD', type:'...'} objects", items: { type: "object" } },
      notes: { type: "string" },
      supersedes: { type: "string", description: "FON of the forecast this final notice replaces. Its row is updated in place (new FON, old FON kept in notes) instead of a second row being added." },
    }, ["fon", "title"]),
    handler: async (a: Record<string, unknown>) => {
      // Send only what the caller provided, so an existing row keeps the fields you did not mention.
      // A new row also gets status 'open' unless one is given; an existing row keeps its status.
      const fon = String(a.fon ?? "").trim();
      if (!fonKey(fon)) throw new Error("fon must contain letters or digits, e.g. RFA-MH-25-123");
      const body: Record<string, unknown> = { title: a.title };
      const scalars = ["status", "activity_code", "url", "purpose", "posted_date", "open_date", "expiration_date", "budget_ceiling", "notes"];
      for (const k of scalars) if (a[k] != null) body[k] = a[k];
      if (a.participating_orgs != null) body.participating_orgs = coerceArray(a.participating_orgs);
      if (a.relevance_tags != null) body.relevance_tags = coerceArray(a.relevance_tags);
      if (a.due_dates != null) body.due_dates = coerceArray(a.due_dates, true);

      // One call, one row (D5): found by its FON key, the key uq_funding_opportunities_fon_key
      // refuses a second row by. A notice URL another call also holds is a hint, never an identity:
      // a landing page can list several calls (_shared/kg-write.ts decideFundingCall).
      const calls = await restAllC("funding_opportunities?select=id,fon,url,notes") as CallRow[];
      const decision = decideFundingCall(calls, { fon, url: a.url as string | undefined, supersedes: a.supersedes as string | undefined });
      if (decision.action === "refuse") throw new Error(decision.error);
      const notes = decision.notes;
      const note = notes.length ? { note: notes.join(" ") } : {};
      // What a unique index refused, said as what it is: the FON another call holds (written in the
      // meantime, or not readable to this account), or the notice URL, which only a database that
      // still has uq_funding_opportunities_url_key refuses: then say which call holds it, and that
      // supersedes is how a final notice replaces its forecast.
      const sharing = decision.sharing;
      const refusedBy = (e: unknown, updating?: CallRow) => {
        const subject = updating ? `${updating.fon} (id ${updating.id}) was not updated` : `${fon} was not added`;
        if (!/url/i.test(violatedConstraint(e) ?? "")) {
          return new Error(`${subject}: that FON is already in the KG (${uniqueViolationText(e)}), written in the meantime or not readable ` +
            "to this account. Nothing was written; list_funding_opportunities shows it.");
        }
        const holder = sharing.length
          ? `It is on ${sharing.map((r) => `${r.fon} (id ${r.id})`).join(", ")}. ` +
            (updating
              ? "If that is this call's forecast, merge it into this one. "
              : `If ${fon} is the final notice that replaces that forecast, call again with supersedes="${sharing[0].fon}". `) +
            "If it is a different call on the same landing page, this database's uq_funding_opportunities_url_key has to be dropped " +
            "first (a URL is not a call's identity): ask an admin."
          : "That call was written in the meantime or is not readable to this account; list_funding_opportunities shows it.";
        return new Error(`${subject}: its notice URL is already on another call, and this database still refuses a shared ` +
          `notice URL (${uniqueViolationText(e)}). Nothing was written. ${holder}`);
      };

      if (decision.action === "update") {
        const row = decision.row;
        let patch = body;
        if (decision.matchedBy === "supersedes") {
          // The final notice takes over its forecast's row, in place: one call, one node.
          const kept = String(body.notes ?? row.notes ?? "");
          const stamp = `Supersedes ${row.fon} (${new Date().toISOString().slice(0, 10)})`;
          patch = { ...body, fon, notes: kept.includes(String(row.fon)) ? kept : kept.trim() ? `${kept}\n${stamp}` : stamp };
        }
        let rows: unknown;
        try {
          rows = await restC(`funding_opportunities?id=eq.${row.id}`, {
            method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch),
          });
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
          throw refusedBy(e, row);
        }
        // RLS filters a forbidden UPDATE to zero rows instead of erroring; say so rather than "updated".
        if (!Array.isArray(rows) || !rows.length) {
          throw new Error(`${row.fon} is in the KG (id ${row.id}) but RLS did not let this account update it; nothing changed.`);
        }
        return text({ action: "already_in_kg", matched_by: decision.matchedBy, id: row.id, ...note, rows });
      }

      try {
        const rows = await restC("funding_opportunities", {
          method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "open", ...body, fon }),
        });
        return text({ action: "inserted", rows, ...note });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        throw refusedBy(e);
      }
    },
  });

  // Category → resources.resource_type. The display category itself lives in metadata.category,
  // which is what the Resources page filters on (useResources → mapDbToResource).
  const RESOURCE_CATEGORY_TYPE: Record<string, string> = {
    Software: "software", Libraries: "software", "ML Models": "ml_model",
    Datasets: "dataset", Benchmarks: "benchmark", Protocols: "protocol",
  };

  T("add_resource", {
    description: "[curator] Add a tool/library/model/dataset/benchmark/protocol to the public Resources page. name + category required. Matches a row of the same type already in the KG by its name (case, spacing and punctuation aside) and fills only the fields you pass on that row (action already_in_kg), so re-running never duplicates; two rows with that name are refused until they are merged. A homepage or repository URL is not an identity (a lab's tools share its homepage): a different-named row with the same URL is never changed, only named in the result's note. To update a row that has another name (an alias or rename), pass same_as=<its id>. THE tool for \"add X to the resources page\" — never fall back to SQL.",
    parameters: obj({
      name: { type: "string" },
      same_as: { type: "string", description: "Optional: the id of the resource already in the KG that this one IS, when its name there differs (an alias or rename). That row is updated instead of a new one added." },
      category: { type: "string", enum: Object.keys(RESOURCE_CATEGORY_TYPE) },
      url: { type: "string", description: "Homepage or docs URL (aliases accepted: link, website, homepage, external_url)" },
      description: { type: "string", description: "One line: what it does" },
      repo_url: { type: "string" },
      version: { type: "string" },
      computational: { type: "string", description: "Methods/algorithms it implements" },
      neural_network_architecture: { type: "string" },
      ml_pipeline: { type: "string" },
      implementation: { type: "string", description: "Language/framework, e.g. 'Python (JAX)'" },
      species: { type: "string" },
      containerized: { type: "boolean" },
    }, ["name", "category"]),
    handler: async (a: Record<string, any>) => {
      // Clients guess the link field name; accept common aliases rather than silently dropping the link (#501).
      if (a.url == null) {
        for (const k of ["external_url", "link", "website", "homepage", "homepage_url", "docs_url"]) {
          if (a[k] != null && String(a[k]).trim()) { a.url = a[k]; break; }
        }
      }
      const resource_type = RESOURCE_CATEGORY_TYPE[a.category];
      if (!resource_type) throw new Error(`category must be one of: ${Object.keys(RESOURCE_CATEGORY_TYPE).join(", ")}`);
      const meta: Record<string, unknown> = { category: a.category };
      const metaKeys: Record<string, string> = {
        repo_url: "repoUrl", version: "version", description: "algorithm", computational: "computational",
        neural_network_architecture: "neuralNetworkArchitecture", ml_pipeline: "mlPipeline",
        implementation: "implementation", species: "species", containerized: "containerized",
      };
      for (const [k, m] of Object.entries(metaKeys)) if (a[k] != null) meta[m] = a[k];
      // Clients may send booleans as strings; the page reads `containerized || false`, so "false" would
      // render as containerized.
      if (meta.containerized != null) meta.containerized = meta.containerized === true || meta.containerized === "true";

      const name = String(a.name).trim();
      // The same thing already in the KG: the same resource_type and the same name key, or the record
      // same_as names (_shared/kg-write.ts decideResource). Never across types: a dataset and the tool
      // that made it may share a name. Never by a URL alone: a lab's tools share its homepage.
      const all = await restAllC("resources?select=id,name,resource_type,external_url,metadata->>repoUrl") as ResourceRow[];
      const decision = decideResource(all, { type: resource_type, name, url: a.url, repoUrl: a.repo_url, sameAs: a.same_as });
      if (decision.action === "refuse") throw new Error(decision.error);
      if (decision.action === "update") {
        const row = decision.row;
        const [current] = await restC(`resources?id=eq.${row.id}&select=metadata`) as Array<{ metadata: Record<string, unknown> | null }>;
        const patch: Record<string, unknown> = { metadata: { ...(current?.metadata ?? {}), ...meta } };
        if (a.url != null) patch.external_url = a.url;
        if (a.description != null) patch.description = a.description;
        const rows = await restC(`resources?id=eq.${row.id}`, {
          method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch),
        });
        // RLS filters a forbidden UPDATE to zero rows instead of erroring; say so rather than "updated".
        if (!Array.isArray(rows) || !rows.length) {
          throw new Error(`"${name}" exists (id ${row.id}) but RLS did not let this account update it; nothing changed. Ask an admin to apply the edit.`);
        }
        return text({ action: "already_in_kg", matched_by: decision.matchedBy, id: row.id,
          ...(row.name !== name ? { name_in_kg: row.name } : {}), ...(decision.note ? { note: decision.note } : {}), rows });
      }
      if (!("mcpStatus" in meta)) meta.mcpStatus = "not-started";
      const rows = await restC("resources", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          name, resource_type, description: a.description ?? null, external_url: a.url ?? null, metadata: meta,
        }),
      });
      // A record that shares only a URL, or the same name under another type: named in the note.
      return text({ action: "inserted", rows, ...(decision.note ? { note: decision.note } : {}) });
    },
  });

  return mcp;
}

const app = new Hono();

app.options("/*", (c) => c.body(null, 204, CORS));

app.get("/bbqs-mcp", (c) =>
  c.json({
    name: "bbqs-mcp",
    version: "3.0.0",
    icons: ICONS,
    description: "BBQS knowledge graph over MCP. Public search anonymously; sign in for member self-service; curators onboard and offboard. One endpoint, step-up OAuth.",
    auth: "OAuth 2.1 via Supabase Auth, on demand. Public tools need no account; the server challenges only when a member or curator tool is called.",
    mcp_endpoint: RESOURCE,
    resource_metadata: RESOURCE_METADATA,
    tools: { public: [...PUBLIC_TOOLS], member: [...MEMBER_TOOLS], curator: [...CURATOR_TOOLS] },
  }, 200, CORS));

app.get("/bbqs-mcp/.well-known/oauth-protected-resource", (c) =>
  c.json({
    resource: RESOURCE,
    authorization_servers: [`${SUPABASE_URL}/auth/v1`],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "email"],
    resource_name: "BBQS knowledge graph",
    resource_documentation: "https://brain-bbqs.org/",
  }, 200, CORS));

app.all("/bbqs-mcp/*", async (c) => {
  const req = c.req.raw;
  const jwt = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const meta: RequestMeta = {
    userAgent: c.req.header("User-Agent") ?? null,
    sessionId: c.req.header("mcp-session-id") ?? null,
  };

  // The body is read before anything can refuse the request, so a refusal is logged with the tools
  // it refused.
  const bodyText = req.method === "POST" ? await req.text() : "";
  const messages = rpcMessages(bodyText);
  const calls = messages.filter((m) => m.method === "tools/call");
  const logRefused = (token: string, error: string) =>
    Promise.all(calls.map((m) => {
      const name = String(m.params?.name ?? "");
      return logCall(token, meta, { tool: name, tier: tierOf(name), outcome: "refused", error, args: m.params?.arguments });
    }));

  // Resolve the caller once if a token was sent. A present-but-invalid token is rejected here so a
  // stale token never silently degrades to anonymous.
  let caller: Caller | null = null;
  if (jwt) {
    caller = await resolveCaller(jwt);
    if (!caller) {
      await logRefused("", "invalid_token");
      return c.json({ error: "invalid_token", error_description: "Token is invalid or expired." },
        401, challenge({ error: "invalid_token" }));
    }
  }

  // Step-up gate. Peek the JSON-RPC body BEFORE the transport runs, so a call above the caller's
  // tier is refused at the HTTP layer with a proper challenge instead of executing.
  if (req.method === "POST") {
    const tier = requiredTier(bodyText);
    if (tier === "curator" && !caller?.isCurator) {
      await logRefused(jwt, caller ? "not a curator" : "not signed in");
      return caller
        ? c.json({ error: "insufficient_scope", error_description: `${caller.email} is not a BBQS curator.` },
            403, challenge({ error: "insufficient_scope", scope: "curator" }))
        : c.json({ error: "unauthorized", error_description: "Sign in as a BBQS curator to use this tool." },
            401, challenge({ scope: "curator" }));
    }
    if (tier === "member" && !caller) {
      await logRefused(jwt, "not signed in");
      return c.json({ error: "unauthorized", error_description: "Sign in to use this tool." },
        401, challenge());
    }
  }

  // The body stream was consumed by the peek, so rebuild the request for the transport.
  const forwarded = req.method === "POST"
    ? new Request(req.url, { method: "POST", headers: req.headers, body: bodyText })
    : req;

  try {
    const handler = new StreamableHttpTransport().bind(buildServer(jwt, caller, meta));
    const res = await handler(forwarded);
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    // initialize is where a client says what it is; the session id it is given comes back on the response.
    for (const m of messages.filter((x) => x.method === "initialize")) {
      const ci = m.params?.clientInfo;
      await logCall(jwt, { ...meta, sessionId: res.headers.get("mcp-session-id") ?? meta.sessionId }, {
        tool: "(initialize)", tier: "public", outcome: res.ok ? "ok" : "error", method: "initialize",
        clientName: ci?.name ? `${ci.name}${ci.version ? ` ${ci.version}` : ""}` : null,
      });
    }
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[bbqs-mcp]", msg);
    return c.json({ error: "MCP transport error", detail: msg }, 500, CORS);
  }
});

Deno.serve(app.fetch);
