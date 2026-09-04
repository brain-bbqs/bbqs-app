import { McpServer, StreamableHttpTransport } from "npm:mcp-lite@^0.10.0";
import { Hono } from "npm:hono@^4.9.7";
import { searchProjects, listSpecies } from "../_shared/kg.ts";
import { askKG } from "../_shared/rag.ts";

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
const PUBLIC_TOOLS = new Set(["search_projects", "list_species", "ask_bbqs"]);
const MEMBER_TOOLS = new Set(["whoami", "my_onboarding_status", "update_my_profile", "request_working_groups"]);
const CURATOR_TOOLS = new Set([
  "onboarding_status", "recent_onboardings", "find_person", "whois", "kg_query", "onboard_member",
  "sync_member_groups", "group_audit", "send_welcome_email", "slack_channels", "set_onboarding_step",
  "offboard_member",
]);

type Caller = { id: string; email: string; roles: string[]; isCurator: boolean };

const text = (v: unknown) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});

/** PostgREST under the caller's identity. RLS decides what comes back. */
async function rest(jwt: string, pathAndQuery: string, init?: RequestInit) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : null;
}

const rpc = (jwt: string, fn: string, args: unknown) =>
  rest(jwt, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

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

function buildServer(jwt: string, caller: Caller | null) {
  const mcp = new McpServer({ name: "bbqs-mcp", version: "3.0.0" });
  const obj = (properties: Record<string, unknown>, required?: string[]) =>
    ({ type: "object" as const, properties, ...(required ? { required } : {}) });

  // ── PUBLIC — no account ──────────────────────────────────
  mcp.tool("search_projects", {
    description: "Search BBQS consortium projects by species, PI name, or free-text query. Public consortium data; no sign-in.",
    parameters: obj({
      species: { type: "string", description: "e.g. Mouse, Zebrafish" },
      pi: { type: "string" },
      query: { type: "string", description: "Free-text semantic search" },
    }),
    handler: async (a: { species?: string; pi?: string; query?: string }) =>
      text(await searchProjects({ species: a.species, pi: a.pi, query: a.query }, ANON)),
  });

  mcp.tool("list_species", {
    description: "Every species studied across BBQS, with project counts. Public; no sign-in.",
    parameters: obj({}),
    handler: async () => text(await listSpecies(ANON)),
  });

  mcp.tool("ask_bbqs", {
    description: "Ask a natural-language question about the consortium; answered from the knowledge base. Public; no sign-in.",
    parameters: obj({ question: { type: "string" } }, ["question"]),
    handler: async (a: { question: string }) => {
      const { answer, sources } = await askKG(a.question, ANON);
      const src = sources.length ? sources.map((s) => `[${s.type}] ${s.title}`).join(", ") : "none";
      return text(`${answer}\n\nSources: ${src}`);
    },
  });

  // ── MEMBER — any signed-in consortium member ─────────────
  mcp.tool("whoami", {
    description: "[sign-in] Who this session is acting as, and whether they may curate.",
    parameters: obj({}),
    handler: async () => text(caller
      ? { ...caller, note: "Your writes are attributed to this account in data_audit_log." }
      : { signed_in: false }),
  });

  mcp.tool("my_onboarding_status", {
    description: "[sign-in] Your own onboarding checklist and remaining steps.",
    parameters: obj({}),
    handler: async () => text(await rest(jwt, "onboarding_pipeline?select=*")),
  });

  mcp.tool("update_my_profile", {
    description: "[sign-in] Edit your OWN profile: institution, ORCID, research areas, skills, secondary emails. Cannot set your role or mailing-list groups — use request_working_groups for those.",
    parameters: obj({
      institution: { type: "string" },
      orcid: { type: "string" },
      research_areas: { type: "array", items: { type: "string" } },
      skills: { type: "array", items: { type: "string" } },
      secondary_emails: { type: "array", items: { type: "string" } },
    }),
    handler: async (a: Record<string, unknown>) => text(await rpc(jwt, "member_self_update", {
      _institution: a.institution ?? null, _orcid: a.orcid ?? null,
      _research_areas: a.research_areas ?? null, _skills: a.skills ?? null,
      _secondary_emails: a.secondary_emails ?? null, _requested_working_groups: null,
    })),
  });

  mcp.tool("request_working_groups", {
    description: "[sign-in] Request to join working groups (WG-Analytics, WG-Devices, WG-ELSI, WG-Standards). This is a REQUEST — a curator approves it before the mailing lists change. You cannot self-subscribe.",
    parameters: obj({ working_groups: { type: "array", items: { type: "string" } } }, ["working_groups"]),
    handler: async (a: { working_groups: string[] }) => text(await rpc(jwt, "member_self_update", {
      _institution: null, _orcid: null, _research_areas: null, _skills: null,
      _secondary_emails: null, _requested_working_groups: a.working_groups ?? [],
    })),
  });

  // ── CURATOR — admin/curator only ─────────────────────────
  mcp.tool("onboarding_status", {
    description: "[curator] Everyone still being onboarded (onboarding_pipeline): steps done/total, days in flight, stuck flag, checklist. The surface for a NEW team. Use group_audit for people who finished and drifted.",
    parameters: obj({
      grant_number: { type: "string" },
      stuck_only: { type: "boolean" },
    }),
    handler: async (a: { grant_number?: string; stuck_only?: boolean }) => {
      let q = "onboarding_pipeline?select=*&order=name";
      if (a.stuck_only) q += "&is_stuck=is.true";
      const rows = await rest(jwt, q) as Array<Record<string, unknown>>;
      if (!a.grant_number) return text(rows);
      const ids = await rest(jwt,
        `grant_investigators?select=investigator_id,grants!inner(grant_number)&grants.grant_number=eq.${encodeURIComponent(a.grant_number)}`) as Array<{ investigator_id: string }>;
      const keep = new Set(ids.map((r) => r.investigator_id));
      return text(rows.filter((r) => keep.has(String(r.id))));
    },
  });

  mcp.tool("recent_onboardings", {
    description: "[curator] The most recently ADDED people, newest first — the reliable answer to \"who joined recently / who was last onboarded\". Ordered by investigators.created_at, with each person's grant roster and onboarding progress. Use this, NOT onboarding_completed_at: that column is stamped only on formal completion and is null for most members, including brand-new roster additions still in flight, so ordering by it answers a different and misleading question.",
    parameters: obj({ limit: { type: "number", description: "How many to return (default 10, max 50)" } }),
    handler: async (a: { limit?: number }) => {
      const n = Math.min(Math.max(Math.trunc(a.limit ?? 10), 1), 50);
      return text(await rest(jwt,
        `investigators?select=name,email,created_at,onboarding_completed_at,onboarding_checklist,grant_investigators(role,role_source,grants(grant_number))&order=created_at.desc&limit=${n}`));
    },
  });

  mcp.tool("whois", {
    description: "[admin] Resolve a user_id OR email to identity — email, created_at, last sign-in, roles, and the linked investigator profile if one exists. Reads auth.users through an admin-gated SECURITY DEFINER function; this is the ONLY way to identify an account that has NO investigator profile (e.g. an admin the roster cannot name). Admin only — a curator who is not an admin gets a permission error, by design.",
    parameters: obj({ user_id: { type: "string" }, email: { type: "string" } }),
    handler: async (a: { user_id?: string; email?: string }) =>
      text(await rpc(jwt, "admin_lookup_user", { _user_id: a.user_id ?? null, _email: a.email ?? null })),
  });

  mcp.tool("find_person", {
    description: "[curator] Find people by email, name fragment, or grant number. Searches secondary_emails, where alias duplicates hide. Returns roster roles alongside the profile (grant role and consortium role are different columns, #283).",
    parameters: obj({ query: { type: "string" } }, ["query"]),
    handler: async (a: { query: string }) => {
      const q = a.query.trim();
      const enc = encodeURIComponent(q);
      if (/^[A-Z0-9]+$/i.test(q) && /\d/.test(q)) {
        return text(await rest(jwt,
          `grant_investigators?select=role,role_source,investigators(id,name,email,secondary_emails,role,institution,onboarding_checklist),grants!inner(grant_number)&grants.grant_number=eq.${enc}`));
      }
      const like = encodeURIComponent(`*${q}*`);
      return text(await rest(jwt,
        `investigators?select=id,name,email,secondary_emails,role,institution,working_groups,onboarding_completed_at,grant_investigators(role,role_source,grants(grant_number))&or=(email.ilike.${like},name.ilike.${like},secondary_emails.cs.{${enc}})`));
    },
  });

  mcp.tool("kg_query", {
    description: "[curator] Read-only PostgREST escape hatch, run as the caller so RLS applies. e.g. \"grants?select=grant_number,title&limit=5\". For exceptions no fixed tool anticipates. Refuses anything but a read.",
    parameters: obj({ path: { type: "string" } }, ["path"]),
    handler: async (a: { path: string }) => {
      const p = a.path.replace(/^\/+/, "");
      if (/^rpc\//i.test(p)) throw new Error("kg_query is read-only; use the dedicated tools for RPCs.");
      return text(await rest(jwt, p));
    },
  });

  mcp.tool("onboard_member", {
    description: "[curator] Create/update a person and optionally link them to a grant roster, seeding their checklist. The roster link is load-bearing: pi@ derives from grant_investigators, not the role label. NOTE: raises 42P01 if the person has BOTH an emailed record and an email-less name twin — run find_person first when unsure.",
    parameters: obj({
      email: { type: "string" }, name: { type: "string" },
      role: { type: "string", description: "contact_pi, co_pi, mpi, co-investigator, postdoc, graduate_student, research_staff" },
      grant_id: { type: "string" },
      working_groups: { type: "array", items: { type: "string" } },
      institution: { type: "string" },
      secondary_emails: { type: "array", items: { type: "string" } },
    }, ["email", "name", "role"]),
    handler: async (a: Record<string, unknown>) => text(await rpc(jwt, "onboard_member", {
      _email: a.email, _name: a.name, _role: a.role, _grant_id: a.grant_id ?? null,
      _working_groups: a.working_groups ?? [], _institution: a.institution ?? null,
      _secondary_emails: a.secondary_emails ?? [],
    })),
  });

  mcp.tool("sync_member_groups", {
    description: "[curator] Add a person to the Google Groups their role and working groups entitle them to. Additive; never removes. ONE call covers every group. pi@ is decided from the roster, so link the roster BEFORE this or it adds consortium@ only and still reports success.",
    parameters: obj({
      email: { type: "string" }, role: { type: "string" },
      working_groups: { type: "array", items: { type: "string" } },
    }, ["email"]),
    handler: async (a: { email: string; role?: string; working_groups?: string[] }) =>
      text(await callFunction(jwt, "sync-member-groups", {
        email: a.email, old: { working_groups: [], role: null },
        new: { working_groups: a.working_groups ?? [], role: a.role ?? null },
      })),
  });

  mcp.tool("group_audit", {
    description: "[curator] Diff LIVE Google Group membership against the roster. action=audit writes nothing; action=repair adds the missing, never removes. 'In Google' minus 'Expected' is NOT drift (expected counts primary addresses only). Trust 'missing' and the unentitled list.",
    parameters: obj({ action: { type: "string", enum: ["audit", "repair"] } }),
    handler: async (a: { action?: string }) =>
      text(await callFunction(jwt, "group-audit", { action: a.action === "repair" ? "repair" : "audit" })),
  });

  mcp.tool("send_welcome_email", {
    description: "[curator] Send the BBQS welcome email to one person. OUTWARD-FACING — confirm with the human first. Groups and Drive should already be done, because the email states they have been. One email per award, contact PI first — see docs/templates/welcome-new-team.md and its standing NIH cc list.",
    parameters: obj({ email: { type: "string" }, name: { type: "string" }, role: { type: "string" } }, ["email", "name"]),
    handler: async (a: { email: string; name: string; role?: string }) =>
      text(await callFunction(jwt, "send-welcome-email", { to: a.email, name: a.name, role: a.role ?? null })),
  });

  mcp.tool("slack_channels", {
    description: "[curator] action=check reports workspace/channel membership; action=invite adds the configured channels. Workspace ENTRY for an external guest is a manual Slack invite — check first and expect not_in_workspace for new external people.",
    parameters: obj({
      email: { type: "string" }, action: { type: "string", enum: ["check", "invite"] },
      role: { type: "string" }, working_groups: { type: "array", items: { type: "string" } },
    }, ["email"]),
    handler: async (a: { email: string; action?: string; role?: string; working_groups?: string[] }) =>
      text(await callFunction(jwt, "slack-channels", {
        email: a.email, role: a.role ?? null, working_groups: a.working_groups ?? [],
        action: a.action === "invite" ? "invite" : "check",
      })),
  });

  mcp.tool("set_onboarding_step", {
    description: "[curator] Mark one checklist step done/pending/not_started/skipped. Call ONLY after the tool that performs the action succeeded — a step marked done is a claim the outward action happened. Steps: kg_created, grant_link, consortium_group, pi_group, young_investigators_group, wg_groups, welcome_email, data_questionnaire, slack.",
    parameters: obj({
      investigator_id: { type: "string" }, step: { type: "string" },
      status: { type: "string", enum: ["done", "pending", "not_started", "skipped"] },
    }, ["investigator_id", "step", "status"]),
    handler: async (a: { investigator_id: string; step: string; status: string }) =>
      text(await rpc(jwt, "set_onboarding_step", { _investigator_id: a.investigator_id, _step: a.step, _status: a.status })),
  });

  mcp.tool("offboard_member", {
    description: "[curator] Remove someone from ONE grant, or the consortium when grant_id is omitted. Multi-grant safe: access justified by a remaining award is kept. Returns the groups no longer justified — removing them is a SEPARATE outward-facing step. Never deletes the person.",
    parameters: obj({ investigator_id: { type: "string" }, grant_id: { type: "string" } }, ["investigator_id"]),
    handler: async (a: { investigator_id: string; grant_id?: string }) =>
      text(await rpc(jwt, "offboard_member", { _investigator_id: a.investigator_id, _grant_id: a.grant_id ?? null })),
  });

  return mcp;
}

const app = new Hono();

app.options("/*", (c) => c.body(null, 204, CORS));

app.get("/bbqs-mcp", (c) =>
  c.json({
    name: "bbqs-mcp",
    version: "3.0.0",
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

  // Resolve the caller once if a token was sent. A present-but-invalid token is rejected here so a
  // stale token never silently degrades to anonymous.
  let caller: Caller | null = null;
  if (jwt) {
    caller = await resolveCaller(jwt);
    if (!caller) {
      return c.json({ error: "invalid_token", error_description: "Token is invalid or expired." },
        401, challenge({ error: "invalid_token" }));
    }
  }

  // Step-up gate. Peek the JSON-RPC body BEFORE the transport runs, so a call above the caller's
  // tier is refused at the HTTP layer with a proper challenge instead of executing.
  let bodyText = "";
  if (req.method === "POST") {
    bodyText = await req.text();
    const tier = requiredTier(bodyText);
    if (tier === "curator" && !caller?.isCurator) {
      return caller
        ? c.json({ error: "insufficient_scope", error_description: `${caller.email} is not a BBQS curator.` },
            403, challenge({ error: "insufficient_scope", scope: "curator" }))
        : c.json({ error: "unauthorized", error_description: "Sign in as a BBQS curator to use this tool." },
            401, challenge({ scope: "curator" }));
    }
    if (tier === "member" && !caller) {
      return c.json({ error: "unauthorized", error_description: "Sign in to use this tool." },
        401, challenge());
    }
  }

  // The body stream was consumed by the peek, so rebuild the request for the transport.
  const forwarded = req.method === "POST"
    ? new Request(req.url, { method: "POST", headers: req.headers, body: bodyText })
    : req;

  try {
    const handler = new StreamableHttpTransport().bind(buildServer(jwt, caller));
    const res = await handler(forwarded);
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[bbqs-mcp]", msg);
    return c.json({ error: "MCP transport error", detail: msg }, 500, CORS);
  }
});

Deno.serve(app.fetch);
