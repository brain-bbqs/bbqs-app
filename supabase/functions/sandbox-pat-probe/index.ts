// Temporary diagnostic: verifies SANDBOX_GITHUB_PAT can reach the sandbox repo.
// Never returns the token itself — only GitHub's status and scope headers.
Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const pat = Deno.env.get("SANDBOX_GITHUB_PAT");
  if (!pat) {
    return new Response(JSON.stringify({ error: "SANDBOX_GITHUB_PAT not configured" }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "BBQS-Sandbox-Probe",
  };

  const user = await fetch("https://api.github.com/user", { headers });
  const repo = await fetch("https://api.github.com/repos/brain-bbqs/bbqs-website-sandbox", { headers });

  return new Response(JSON.stringify({
    token_prefix: pat.slice(0, 4),
    token_length: pat.length,
    user_status: user.status,
    user_login: user.ok ? (await user.json()).login : (await user.text()).slice(0, 200),
    scopes: user.headers.get("x-oauth-scopes"),
    repo_status: repo.status,
    repo_message: repo.ok ? "accessible" : (await repo.text()).slice(0, 200),
  }, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
});
