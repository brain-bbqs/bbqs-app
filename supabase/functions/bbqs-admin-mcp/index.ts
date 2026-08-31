import { McpServer, StreamableHttpTransport } from "npm:mcp-lite@^0.10.0";
import { Hono } from "npm:hono@^4.9.7";

// BBQS admin MCP — onboarding and offboarding, driven by a curator.
//
// SEPARATE from bbqs-mcp, which is anon, read-only and public consortium data. Admin writes do not
// belong on a public endpoint, and the two have opposite auth models.
//
// EVERY TOOL ACTS AS THE CALLER. The caller's Supabase JWT is forwarded verbatim to PostgREST and
// to the edge functions below, so RLS applies, the SECURITY DEFINER RPCs see a real auth.uid(),
// and data_audit_log names a person rather than an unattributed service-role write. No service-role
// key is held here at all. That also settles the reachability problem: group-audit and every
// SECURITY DEFINER RPC gate on auth.uid(), so a service-role token could not drive them anyway.
//
// The server is BUILT PER REQUEST because tool handlers close over that JWT — a module-level
// "current token" would be a cross-request leak the first time two curators overlap.
//
// Deploy: supabase functions deploy bbqs-admin-mcp --project-ref vpexxhfpvghlejljwpvt
// See docs/onboarding-a-new-award.md for the sequence these tools implement, and why the order
// matters (roster before groups; groups and Drive before the welcome email; Slack check before
// invite).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, mcp-session-id, mcp-protocol-version",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

const text = (v: unknown) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});

/** PostgREST under the caller's identity. RLS decides what comes back. */
async function rest(jwt: string, pathAndQuery: string, init?: RequestInit) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
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

/** Who is calling, and may they curate? Read from the token, never from tool arguments. */
async function resolveCaller(jwt: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) return null;
  const user = await res.json() as { id?: string; email?: string };
  if (!user?.id) return null;
  const roles = await rest(jwt, `user_roles?select=role&user_id=eq.${user.id}`)
    .catch(() => [] as Array<{ role: string }>);
  const names = (roles ?? []).map((r: { role: string }) => r.role);
  return { id: user.id, email: user.email ?? "", roles: names,
           isCurator: names.includes("admin") || names.includes("curator") };
}

function buildServer(jwt: string, caller: { email: string; roles: string[] }) {
  const mcp = new McpServer({ name: "bbqs-admin-mcp", version: "1.0.0" });
  const obj = (properties: Record<string, unknown>, required?: string[]) =>
    ({ type: "object" as const, properties, ...(required ? { required } : {}) });

  mcp.tool("whoami", {
    description: "Who this session is acting as, and whether they may curate. Every other tool acts as this person.",
    parameters: obj({}),
    handler: async () => text({ ...caller, note: "All writes are attributed to this account in data_audit_log." }),
  });

  // ── Read ────────────────────────────────────────────────
  mcp.tool("onboarding_status", {
    description:
      "People still being onboarded, from the onboarding_pipeline view: steps done out of total, days in flight, whether stuck, and the per-step checklist. This is the surface for a NEW team — a fresh award appears here the moment its roster lands. Use group_audit instead for people who already finished and have since drifted.",
    parameters: obj({
      grant_number: { type: "string", description: "Limit to one award, e.g. R61MH142354" },
      stuck_only: { type: "boolean", description: "Only people flagged stuck (>14 days with a required step outstanding)" },
    }),
    handler: async (a: { grant_number?: string; stuck_only?: boolean }) => {
      let q = "onboarding_pipeline?select=*&order=name";
      if (a.stuck_only) q += "&is_stuck=is.true";
      const rows = await rest(jwt, q) as Array<Record<string, unknown>>;
      if (!a.grant_number) return text(rows);
      const ids = await rest(jwt,
        `grant_investigators?select=investigator_id,grants!inner(grant_number)&grants.grant_number=eq.${encodeURIComponent(a.grant_number)}`,
      ) as Array<{ investigator_id: string }>;
      const keep = new Set(ids.map((r) => r.investigator_id));
      return text(rows.filter((r) => keep.has(String(r.id))));
    },
  });

  mcp.tool("find_person", {
    description:
      "Find people in the knowledge graph by email, name fragment, or grant number. Searches secondary_emails too, which is where alias duplicates hide. Returns roster roles alongside the profile, because role on a grant and consortium role are different columns (issue #283).",
    parameters: obj({
      query: { type: "string", description: "Email, partial name, or grant number" },
    }, ["query"]),
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
    description:
      "Read-only PostgREST escape hatch, run as the caller so RLS applies. Pass a path like \"grants?select=grant_number,title&limit=5\". Use when no other tool fits — onboarding turns up exceptions no fixed tool surface anticipates. Refuses anything but a read.",
    parameters: obj({
      path: { type: "string", description: "PostgREST path and query, without a leading slash" },
    }, ["path"]),
    handler: async (a: { path: string }) => {
      const p = a.path.replace(/^\/+/, "");
      if (/^rpc\//i.test(p)) throw new Error("kg_query is read-only; use the dedicated tools for RPCs.");
      return text(await rest(jwt, p));
    },
  });

  // ── Write ───────────────────────────────────────────────
  mcp.tool("onboard_member", {
    description:
      "Create or update a person and optionally link them to a grant roster, seeding their onboarding checklist. The roster link is load-bearing: pi@ entitlement derives from grant_investigators, never from the consortium role label. NOTE: this RPC currently raises 42P01 if the person has BOTH an emailed record and an email-less name twin — its merge branch references a dropped table. Run find_person first when in doubt.",
    parameters: obj({
      email: { type: "string" },
      name: { type: "string" },
      role: { type: "string", description: "Canonical roster token: contact_pi, co_pi, mpi, co-investigator, postdoc, graduate_student, research_staff" },
      grant_id: { type: "string", description: "uuid of the grant to link" },
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
    description:
      "Add a person to the Google Groups their role and working groups entitle them to — consortium@, pi@, young-investigators@, wg-*@. Additive; never removes. ONE call covers every group, so consortium_group and pi_group are both satisfied by it. pi@ is decided from the grant roster, so link the roster BEFORE calling this or it adds consortium@ only and still reports success.",
    parameters: obj({
      email: { type: "string" },
      role: { type: "string", description: "The person's consortium role label" },
      working_groups: { type: "array", items: { type: "string" } },
    }, ["email"]),
    handler: async (a: { email: string; role?: string; working_groups?: string[] }) =>
      text(await callFunction(jwt, "sync-member-groups", {
        email: a.email,
        old: { working_groups: [], role: null },
        new: { working_groups: a.working_groups ?? [], role: a.role ?? null },
      })),
  });

  mcp.tool("group_audit", {
    description:
      "Diff LIVE Google Group membership against what the roster implies. action=audit writes nothing; action=repair adds the missing and never removes. For people who finished onboarding and drifted — a team still in onboarding_status is not drift. Reading the result: 'In Google' minus 'Expected' is NOT drift, because expected counts primary addresses only while a secondary satisfies membership. Trust 'missing' and the unentitled list.",
    parameters: obj({
      action: { type: "string", enum: ["audit", "repair"], description: "Default audit. Always audit before repair." },
    }),
    handler: async (a: { action?: string }) =>
      text(await callFunction(jwt, "group-audit", { action: a.action === "repair" ? "repair" : "audit" })),
  });

  mcp.tool("send_welcome_email", {
    description:
      "Send the BBQS welcome email to one person. OUTWARD-FACING: confirm with the human before calling. Groups and Drive folders should already be done, because the email states they have been. For a new award the convention is one email to all PIs together, contact PI first — see docs/templates/welcome-new-team.md, which also holds the standing NIH cc list.",
    parameters: obj({
      email: { type: "string" }, name: { type: "string" }, role: { type: "string" },
    }, ["email", "name"]),
    handler: async (a: { email: string; name: string; role?: string }) =>
      text(await callFunction(jwt, "send-welcome-email", { to: a.email, name: a.name, role: a.role ?? null })),
  });

  mcp.tool("slack_channels", {
    description:
      "action=check reports whether the person is in the Slack workspace and which channels they hold; action=invite adds the configured channels. Workspace ENTRY for an external guest cannot be automated — Slack needs a human guest invite — so check first and expect not_in_workspace for new external people.",
    parameters: obj({
      email: { type: "string" },
      action: { type: "string", enum: ["check", "invite"] },
      role: { type: "string" },
      working_groups: { type: "array", items: { type: "string" } },
    }, ["email"]),
    handler: async (a: { email: string; action?: string; role?: string; working_groups?: string[] }) =>
      text(await callFunction(jwt, "slack-channels", {
        email: a.email, role: a.role ?? null, working_groups: a.working_groups ?? [],
        action: a.action === "invite" ? "invite" : "check",
      })),
  });

  mcp.tool("set_onboarding_step", {
    description:
      "Mark one checklist step done, pending, not_started or skipped. Only call this AFTER the tool that performs the action has succeeded — a step marked done is a claim that the outward action happened, and marking it by hand recreates the silent-failure record group_audit exists to catch. Steps: kg_created, grant_link, consortium_group, pi_group, young_investigators_group, wg_groups, welcome_email, data_questionnaire, slack.",
    parameters: obj({
      investigator_id: { type: "string" },
      step: { type: "string" },
      status: { type: "string", enum: ["done", "pending", "not_started", "skipped"] },
    }, ["investigator_id", "step", "status"]),
    handler: async (a: { investigator_id: string; step: string; status: string }) =>
      text(await rpc(jwt, "set_onboarding_step", {
        _investigator_id: a.investigator_id, _step: a.step, _status: a.status,
      })),
  });

  mcp.tool("offboard_member", {
    description:
      "Remove someone from ONE grant's roster, or from the consortium entirely when grant_id is omitted. Multi-grant safe: access justified by a remaining award is kept. Returns the Google Groups no longer justified — removing them is a SEPARATE, deliberate step, because it is outward-facing. Never deletes the person.",
    parameters: obj({
      investigator_id: { type: "string" },
      grant_id: { type: "string", description: "Omit for a full departure from the consortium" },
    }, ["investigator_id"]),
    handler: async (a: { investigator_id: string; grant_id?: string }) =>
      text(await rpc(jwt, "offboard_member", {
        _investigator_id: a.investigator_id, _grant_id: a.grant_id ?? null,
      })),
  });

  return mcp;
}

const app = new Hono();

app.options("/*", (c) => c.body(null, 204, CORS));

app.get("/bbqs-admin-mcp", (c) =>
  c.json({
    name: "bbqs-admin-mcp",
    version: "1.0.0",
    description: "BBQS onboarding and offboarding, acting as the signed-in curator.",
    auth: "Send a Supabase session JWT for an admin or curator as the Authorization bearer token.",
    tools: ["whoami", "onboarding_status", "find_person", "kg_query", "onboard_member",
            "sync_member_groups", "group_audit", "send_welcome_email", "slack_channels",
            "set_onboarding_step", "offboard_member"],
  }, 200, CORS));

app.all("/bbqs-admin-mcp/*", async (c) => {
  const jwt = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return c.json({ error: "Authorization required: a curator's Supabase JWT." }, 401, CORS);

  const caller = await resolveCaller(jwt);
  if (!caller) return c.json({ error: "That token does not resolve to a signed-in user." }, 401, CORS);
  if (!caller.isCurator) {
    return c.json({ error: `${caller.email} is not an admin or curator.` }, 403, CORS);
  }

  try {
    const handler = new StreamableHttpTransport().bind(buildServer(jwt, caller));
    const res = await handler(c.req.raw);
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[bbqs-admin-mcp]", msg);
    return c.json({ error: "MCP transport error", detail: msg }, 500, CORS);
  }
});

Deno.serve(app.fetch);
