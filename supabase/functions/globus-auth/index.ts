import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const ADMIN_NOTIFY_EMAIL = "nader.nikbakht@gmail.com";

// Send an admin email via the auth-notify edge function. Best-effort; never throws.
async function sendAdminEmail(to: string, subject: string, html: string) {
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${SUPABASE_URL}/functions/v1/auth-notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ to, subject, html }),
    });
  } catch (e) {
    console.error("Failed to send admin notification:", e);
  }
}

// Log an auth attempt to auth_audit_log (audit trail only, no email). Best-effort.
async function logAuthFailure(
  supabaseAdmin: ReturnType<typeof createClient>,
  info: FailureInfo,
) {
  try {
    await supabaseAdmin.from("auth_audit_log").insert({
      attempted_email: info.email || null,
      globus_name: info.name || null,
      error_reason: info.errorReason,
      ip_address: info.ipAddress || null,
      metadata: info.metadata || {},
    });
  } catch (e) {
    console.error("Failed to log auth failure:", e);
  }
}

interface FailureInfo {
  email?: string;
  name?: string;
  errorReason: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

// Genuine auth FAILURE (token exchange, userinfo, domain, create-user, session):
// audit-log it AND send the security-alarm email. NOT used for not_a_member, which
// is a would-be member to approve — that path files a request + sends an actionable
// approval notice instead (see the gate below).
async function logAndNotifyFailure(
  supabaseAdmin: ReturnType<typeof createClient>,
  info: FailureInfo,
) {
  await logAuthFailure(supabaseAdmin, info);
  const timestamp = new Date().toISOString();
  const subject = `[BBQS] Failed Auth Attempt: ${info.errorReason}`;
  const body = [
    `<h2>Failed Authentication Attempt</h2>`,
    `<p><strong>Time:</strong> ${timestamp}</p>`,
    `<p><strong>Email:</strong> ${info.email || "unknown"}</p>`,
    `<p><strong>Globus Name:</strong> ${info.name || "unknown"}</p>`,
    `<p><strong>Error:</strong> ${info.errorReason}</p>`,
    `<p><strong>IP:</strong> ${info.ipAddress || "unknown"}</p>`,
    info.metadata
      ? `<p><strong>Details:</strong> <pre>${JSON.stringify(info.metadata, null, 2)}</pre></p>`
      : "",
  ].join("\n");
  await sendAdminEmail(ADMIN_NOTIFY_EMAIL, subject, body);
}

function getClientIp(req: Request): string | undefined {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    undefined
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const GLOBUS_CLIENT_ID = Deno.env.get("GLOBUS_CLIENT_ID")!;
  const GLOBUS_CLIENT_SECRET = Deno.env.get("GLOBUS_CLIENT_SECRET")!;
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const url = new URL(req.url);
  const clientIp = getClientIp(req);

  try {
    // GET request = Globus callback (redirect from Globus after user auth)
    if (req.method === "GET") {
      const code = url.searchParams.get("code");
      const stateParam = url.searchParams.get("state");
      const oauthError = url.searchParams.get("error");

      // Globus returns ?error=login_required when prompt=none and no active session.
      // Decode state to get the frontend URL so we can redirect back gracefully.
      if (oauthError && stateParam) {
        try {
          const stateData = JSON.parse(atob(stateParam));
          const silentFailRedirect = new URL(stateData.redirect_uri);
          silentFailRedirect.searchParams.set("globus_error", "silent_failed");
          return Response.redirect(silentFailRedirect.toString(), 302);
        } catch {
          return new Response("OAuth error: " + oauthError, { status: 400 });
        }
      }

      if (!code || !stateParam) {
        return new Response("Missing code or state", { status: 400 });
      }

      // Decode state to get the frontend redirect URI
      let frontendRedirect: string;
      try {
        const stateData = JSON.parse(atob(stateParam));
        frontendRedirect = stateData.redirect_uri;
      } catch {
        return new Response("Invalid state parameter", { status: 400 });
      }

      const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      // Helper to redirect with error and log/notify
      const errorRedirectAndNotify = async (
        errorCode: string,
        email?: string,
        name?: string,
        extra?: Record<string, unknown>,
      ) => {
        await logAndNotifyFailure(supabaseAdmin, {
          email,
          name,
          errorReason: errorCode,
          ipAddress: clientIp,
          metadata: extra,
        });
        const errorRedirect = new URL(frontendRedirect);
        errorRedirect.searchParams.set("globus_error", errorCode);
        return Response.redirect(errorRedirect.toString(), 302);
      };

      // The redirect_uri for token exchange must be THIS edge function URL
      const edgeFunctionUrl = `${SUPABASE_URL}/functions/v1/globus-auth`;

      // Exchange code for tokens
      const tokenRes = await fetch("https://auth.globus.org/v2/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${btoa(`${GLOBUS_CLIENT_ID}:${GLOBUS_CLIENT_SECRET}`)}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: edgeFunctionUrl,
        }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        console.error("Globus token error:", err);
        return await errorRedirectAndNotify("token_exchange_failed", undefined, undefined, { globus_error: err });
      }

      const tokens = await tokenRes.json();

      // Get user info from Globus
      const userinfoRes = await fetch("https://auth.globus.org/v2/oauth2/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });

      if (!userinfoRes.ok) {
        return await errorRedirectAndNotify("userinfo_failed");
      }

      const userinfo = await userinfoRes.json();
      const name = userinfo.name || userinfo.preferred_username || "";
      // The name we hand back to the frontend (sign-in greeting etc.). Defaults to
      // the Globus-provided name, but is upgraded below to the onboarded investigator
      // name when we have one — so a member whose Globus account name is a username
      // (e.g. "test-user-tier1") is greeted by their real consortium name.
      let displayName = name;

      // Globus asserts MORE THAN ONE identity for a person: `email` (the mailbox,
      // e.g. bey2103@cumc.columbia.edu) and `preferred_username` (the eppn/username,
      // e.g. bey2103@columbia.edu). For institutional identities these frequently
      // DIFFER (med-center subdomain vs base domain), and the address on file in
      // `investigators` may be EITHER one. The membership gate must therefore check
      // EVERY email-like identity Globus vouches for — not just `userinfo.email` —
      // or an invited investigator whose on-file address is their username is wrongly
      // bounced as not_a_member (confirmed 2026-07-14: Brett Youngerman signed in as
      // bey2103@cumc.columbia.edu while the directory held the bey2103@columbia.edu
      // variant, so the single-email gate missed him).
      const assertedIdentities = [userinfo.email, userinfo.preferred_username]
        .filter((v) => typeof v === "string")
        .map((v) => v.toLowerCase().trim())
        .filter((v) => v.includes("@"));
      const candidateEmails = [...new Set(assertedIdentities)];

      if (candidateEmails.length === 0) {
        return await errorRedirectAndNotify("no_email", undefined, name);
      }

      // ===== STRICT MEMBERSHIP GATE =====
      // At least ONE asserted identity MUST already exist on an investigator record
      // (primary or secondary). Pass on the first that matches and adopt it as THE
      // sign-in identity for everything downstream (canonical resolution, linking).
      // If none match, do NOT create an auth.users row — notify admins and route to
      // the intake form.
      let signInEmail: string | null = null;
      for (const cand of candidateEmails) {
        const { data: isMember } = await supabaseAdmin
          .rpc("email_is_consortium_member", { _email: cand });
        if (isMember) {
          signInEmail = cand;
          break;
        }
      }

      if (!signInEmail) {
        // Not on the roster (yet). This is a would-be member to APPROVE, not a
        // security failure — so we (1) record the attempt in the audit log and (2)
        // AUTO-FILE a pending access_request so the attempt becomes an actionable,
        // reviewable item even if the person never finishes the intake form. The
        // ADMIN NOTIFICATION is NOT sent from here: it fires from the AFTER INSERT
        // trigger on access_requests (notify_new_access_request → notify-access-request
        // fn), so it happens exactly once per new request regardless of path — this
        // path, the RPC, or the intake form directly. The intake form (to which we
        // still redirect) folds its richer institution/role details into this SAME
        // pending row via the shared upsert_access_request RPC (an UPDATE, so it does
        // NOT re-notify), so there is no duplicate-request regression and no lost data.

        await logAuthFailure(supabaseAdmin, {
          email: userinfo.email,
          name,
          errorReason: "not_a_member",
          ipAddress: clientIp,
          metadata: {
            globus_username: userinfo.preferred_username,
            identities_checked: candidateEmails,
          },
        });

        // DO NOT auto-file a bare request any more. The attempt is already recorded in the audit
        // log above; a request row created here carries only an email and a Globus display name,
        // because nobody has been asked anything yet.
        //
        // Measured 2026-08-18: 43 of 86 requests came from this path, and 39 of them had no
        // institution and no association — one row and one admin notification email per random
        // person who clicks Sign in. "Brayden / brritter@ualberta.ca / Association not stated" was
        // the one that prompted this: unreviewable by construction, since there is nothing to review.
        //
        // Everyone is still redirected to the intake form, which REQUIRES name, institution, role and
        // a BBQS association, and which upserts on the same email — so anyone who actually wants
        // access produces a complete, decidable request. Someone who does not bother produces an
        // audit-log line instead of admin work, which is the correct trade: a bounced sign-in is not
        // an application.
        //
        // The one thing lost is visibility of attempts that never complete the form. That lives in
        // auth_audit_log with reason 'not_a_member', queryable when it matters, rather than as 39
        // permanently-pending rows nobody can action.

        const errorRedirect = new URL(frontendRedirect);
        errorRedirect.searchParams.set("globus_error", "not_a_member");
        errorRedirect.searchParams.set("globus_email", userinfo.email || candidateEmails[0]);
        if (name) errorRedirect.searchParams.set("globus_name", name);
        if (userinfo.sub) errorRedirect.searchParams.set("globus_subject", userinfo.sub);
        return Response.redirect(errorRedirect.toString(), 302);
      }

      // From here on, `email` is the Globus-asserted identity that matched a
      // consortium member; canonical resolution maps it to the primary below.
      const email = signInEmail;

      // Resolve the canonical email for this person.
      let canonicalEmail = email;
      const emailLower = email.toLowerCase();

      // Check if this email is a secondary_email for any investigator
      const { data: invBySecondaryRows } = await supabaseAdmin
        .from("investigators")
        .select("email")
        .contains("secondary_emails", [emailLower])
        .not("email", "is", null)
        .order("updated_at", { ascending: false })
        .limit(1);
      const invBySecondary = invBySecondaryRows?.[0];

      if (invBySecondary?.email) {
        canonicalEmail = invBySecondary.email;
        console.log(`Resolved secondary email ${email} → canonical ${canonicalEmail}`);
      } else {
        const { data: invByPrimaryRows } = await supabaseAdmin
          .from("investigators")
          .select("email")
          .ilike("email", emailLower)
          .limit(1);
        const invByPrimary = invByPrimaryRows?.[0];
        if (invByPrimary?.email) {
          canonicalEmail = invByPrimary.email;
        }
      }

      // Check if user exists (by canonical email). listUsers() is paginated —
      // default perPage is ~50, so with >50 members we MUST walk every page or
      // we'll miss existing users and then fail with email_exists on createUser.
      const canonicalLower = canonicalEmail.toLowerCase();
      let existingUser: any = undefined;
      const perPage = 1000;
      for (let page = 1; page <= 50; page++) {
        const { data: pageData, error: listErr } =
          await supabaseAdmin.auth.admin.listUsers({ page, perPage });
        if (listErr) {
          console.error("listUsers error on page", page, listErr);
          break;
        }
        const users = pageData?.users ?? [];
        existingUser = users.find(
          (u: any) => u.email?.toLowerCase() === canonicalLower,
        );
        if (existingUser) break;
        if (users.length < perPage) break; // last page
      }

      let userId: string;

      if (existingUser) {
        userId = existingUser.id;
      } else {
        // Validate: either the domain is allowed OR this person is a known consortium member
        const domain = canonicalEmail.split("@")[1]?.toLowerCase();
        const { data: allowedDomain } = await supabaseAdmin
          .from("allowed_domains")
          .select("domain")
          .eq("domain", domain)
          .maybeSingle();

        const { data: knownInvestigatorRows } = await supabaseAdmin
          .from("investigators")
          .select("id")
          .or(`email.ilike.${emailLower},secondary_emails.cs.{${emailLower}}`)
          .limit(1);
        const knownInvestigator = knownInvestigatorRows?.[0];

        if (!allowedDomain && !knownInvestigator) {
          return await errorRedirectAndNotify("domain_not_allowed", email, name, {
            domain,
            globus_username: userinfo.preferred_username,
          });
        }

        const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
          email: canonicalEmail,
          email_confirm: true,
          user_metadata: { full_name: name },
        });

        if (createError) {
          // Race / pagination miss: if the user actually exists, recover by
          // signing them in instead of failing the whole flow.
          const code = (createError as any).code || "";
          if (code === "email_exists" || /already been registered/i.test(createError.message)) {
            // Fall through to generateLink below using canonicalEmail.
            console.warn("createUser reported email_exists; proceeding with magic link for", canonicalEmail);
            userId = ""; // unused downstream
          } else {
            console.error("Create user error:", createError);
            return await errorRedirectAndNotify("create_user_failed", email, name, {
              error: createError.message,
            });
          }
        } else {
          userId = newUser.user.id;
        }
      }

      // Link the investigator record to this auth user on EVERY sign-in. The
      // auto_link_investigator trigger only fires on auth-user INSERT, so a member
      // who is RE-ONBOARDED after a reset (their auth.users row already exists) is
      // never re-linked — their new investigator row keeps user_id = NULL and the
      // agent's member context (which resolves by user_id under RLS) can't see it
      // (blank profile, no onboarding steps). Match primary OR secondary email; only
      // set when currently NULL so an already-linked row is never re-pointed.
      // Best-effort: must NOT block sign-in.
      try {
        // Find the unlinked investigator(s) matching this email (primary or secondary).
        // There can be DUPLICATE rows for one person (same email, multiple records). A
        // blanket UPDATE would set the SAME user_id on >1 row → unique-constraint
        // violation → the whole update fails and the member is NEVER linked (so the
        // agent can't resolve them by user_id). So link EXACTLY ONE row — the most
        // recently updated (the active record, e.g. the one carrying the grant link) —
        // and log any duplicates so they can be de-duped.
        const { data: matches } = await supabaseAdmin
          .from("investigators")
          .select("id")
          .or(`email.ilike.${canonicalEmail},secondary_emails.cs.{${emailLower}}`)
          .is("user_id", null)
          .order("updated_at", { ascending: false });
        if (matches && matches.length > 0) {
          if (matches.length > 1) {
            console.warn(
              `Multiple unlinked investigators for ${canonicalEmail} (${matches.length}) — linking the most recent; de-dup the rest:`,
              (matches as Array<{ id: string }>).map((m) => m.id).join(", "),
            );
          }
          const targetId = (matches[0] as { id: string }).id;
          const { error: linkErr } = await supabaseAdmin
            .from("investigators")
            .update({ user_id: userId })
            .eq("id", targetId);
          if (linkErr) console.error("investigator user_id link failed:", linkErr.message);
        }
      } catch (linkEx) {
        console.error("investigator link threw:", linkEx instanceof Error ? linkEx.message : String(linkEx));
      }

      // ===== TIER → ROLE SYNC (KG user_roles + agent app_metadata.role) =====
      // An admin sets an access tier at onboarding → investigators.pending_role
      // (admin/curator/member). Two separate role systems must reflect it:
      //   • user_roles  — KG RLS (has_role / is_curator_or_admin)
      //   • app_metadata.role on the auth user — the AGENT's persona tier
      //     (resolveUserRole reads ONLY app_metadata.role; user_roles is invisible
      //      to it), which is why an elevated member previously never saw Admin MODE.
      // The auto_link_investigator trigger promotes pending_role → user_roles ONLY
      // on auth-user INSERT, and NOTHING ever set app_metadata.role. So we do both
      // here, on EVERY sign-in: (1) promote any lingering pending_role (covers the
      // re-onboard case where the trigger didn't fire), (2) mirror the highest
      // ELEVATED user_roles role into app_metadata.role. Elevate-only — we never
      // downgrade here, to avoid clobbering an admin granted out-of-band; role
      // REMOVAL is handled on the offboarding path. Best-effort: never block sign-in.
      try {
        const { data: invRow } = await supabaseAdmin
          .from("investigators")
          .select("pending_role, name")
          .eq("user_id", userId)
          .maybeSingle();
        const pending = (invRow?.pending_role as string | null) ?? null;

        // (1) Re-onboard: promote pending_role → user_roles ourselves, then clear it.
        if (pending && pending !== "member") {
          const { data: have } = await supabaseAdmin
            .from("user_roles")
            .select("user_id")
            .eq("user_id", userId)
            .eq("role", pending)
            .maybeSingle();
          if (!have) {
            const { error: roleInsErr } = await supabaseAdmin
              .from("user_roles")
              .insert({ user_id: userId, role: pending });
            if (roleInsErr) console.error("user_roles insert failed:", roleInsErr.message);
          }
        }
        if (pending) {
          await supabaseAdmin.from("investigators").update({ pending_role: null }).eq("user_id", userId);
        }

        // (2) Mirror the highest ELEVATED user_roles role into app_metadata.role.
        const { data: roleRows } = await supabaseAdmin
          .from("user_roles")
          .select("role")
          .eq("user_id", userId);
        const roleSet = new Set((roleRows ?? []).map((r: any) => r.role as string));
        const elevated = roleSet.has("admin") ? "admin" : roleSet.has("curator") ? "curator" : null;
        if (elevated) {
          const baseMeta = (existingUser?.app_metadata as Record<string, unknown>) ?? {};
          if (baseMeta.role !== elevated) {
            const { error: metaErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
              app_metadata: { ...baseMeta, role: elevated },
            });
            if (metaErr) console.error("app_metadata.role sync failed:", metaErr.message);
            else console.log(`Set app_metadata.role=${elevated} for ${canonicalEmail}`);
          }
        }

        // (3) Backfill profiles.full_name from the investigator name when the profile
        // has no name yet (e.g. Globus returned none) — so the website shows the
        // onboarded name everywhere, not only where it falls back to the investigator
        // record. Only fills an EMPTY name; never overwrites a name the user set.
        const invName = (invRow?.name as string | null)?.trim();
        // Prefer the onboarded investigator name for the frontend greeting.
        if (invName) displayName = invName;
        if (invName) {
          const { data: prof } = await supabaseAdmin
            .from("profiles")
            .select("full_name")
            .eq("id", userId)
            .maybeSingle();
          if (prof && (!prof.full_name || String(prof.full_name).trim() === "")) {
            const { error: nameErr } = await supabaseAdmin
              .from("profiles")
              .update({ full_name: invName })
              .eq("id", userId);
            if (nameErr) console.error("profiles.full_name backfill failed:", nameErr.message);
            else console.log(`Backfilled profiles.full_name='${invName}' for ${canonicalEmail}`);
          }
        }
      } catch (roleEx) {
        console.error("tier→role/name sync threw:", roleEx instanceof Error ? roleEx.message : String(roleEx));
      }

      // Generate magic link using canonical email
      const { data: linkData, error: linkError } =
        await supabaseAdmin.auth.admin.generateLink({
          type: "magiclink",
          email: canonicalEmail,
        });

      if (linkError || !linkData) {
        console.error("Generate link error:", linkError);
        return await errorRedirectAndNotify("session_failed", email, name, {
          error: linkError?.message,
        });
      }

      // Redirect back to frontend with token_hash
      const successRedirect = new URL(frontendRedirect);
      successRedirect.searchParams.set("token_hash", linkData.properties.hashed_token);
      successRedirect.searchParams.set("globus_name", displayName);
      successRedirect.searchParams.set("globus_email", email);

      return Response.redirect(successRedirect.toString(), 302);
    }

    // POST request = login action (initiate Globus OAuth)
    const req_body = await req.json();
    const { action, redirect_uri } = req_body;

    if (action === "login") {
      const silent = req_body?.silent === true;

      // Validate redirect_uri against allowlist to prevent open redirect
      const ALLOWED_REDIRECT_ORIGINS = [
        "https://brain-bbqs.org",
        "https://www.brain-bbqs.org",
        "https://brain-bbqs.github.io",
        "https://brain-bbq-clone.lovable.app",
        "https://agent.brain-bbqs.org",
        "http://localhost:",
      ];
      const isAllowedRedirect = redirect_uri && ALLOWED_REDIRECT_ORIGINS.some(
        (o: string) => redirect_uri.startsWith(o)
      ) || (redirect_uri && /^https:\/\/[a-z0-9-]+\.lovable\.app\//.test(redirect_uri))
        || (redirect_uri && /^https:\/\/[a-z0-9-]+\.workers\.dev\//.test(redirect_uri));

      if (!isAllowedRedirect) {
        return new Response(JSON.stringify({ error: "Invalid redirect_uri" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const edgeFunctionUrl = `${SUPABASE_URL}/functions/v1/globus-auth`;
      const state = btoa(JSON.stringify({ redirect_uri }));

      const authUrl = new URL("https://auth.globus.org/v2/oauth2/authorize");
      authUrl.searchParams.set("client_id", GLOBUS_CLIENT_ID);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", edgeFunctionUrl);
      authUrl.searchParams.set("scope", "openid profile email");
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("prompt", silent ? "none" : "login");

      return new Response(JSON.stringify({ url: authUrl.toString() }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Globus auth error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
