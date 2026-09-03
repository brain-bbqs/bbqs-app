import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, ShieldCheck, ExternalLink, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

// The consent screen for Supabase's OAuth 2.1 server (Authentication > OAuth Server, Authorization
// Path = /oauth/consent). Supabase authenticates and issues the tokens; this page is the only part
// it leaves to us — show who is asking and what for, then approve or deny.
//
// The token an MCP client ends up holding is an ordinary Supabase JWT carrying this user's identity,
// so RLS and every auth.uid() gate apply to it unchanged. That is why bbqs-admin-mcp needs no
// service-role key: an approval here IS the curator's authority, scoped to their own account.
//
// SESSION_RETURN: the sign-in page returns to /dashboard, so an unauthenticated arrival stashes the
// consent URL first and Auth sends the user back here instead. Losing it would drop the
// authorization_id and the client would hang on a request that never returns.
export const OAUTH_RETURN_KEY = "bbqs.oauth.return";

type Client = { id: string; name: string; uri: string; logo_uri: string };
type Details = {
  authorization_id: string;
  redirect_uri: string;
  client: Client;
  user: { id: string; email: string };
  scope: string;
};

export default function OAuthConsent() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const authorizationId = params.get("authorization_id") ?? "";

  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState<{ approved: boolean; url: string } | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      sessionStorage.setItem(OAUTH_RETURN_KEY, `/oauth/consent${window.location.search}`);
      navigate("/auth");
      return;
    }
    if (!authorizationId) {
      setError("This link is missing its authorization_id, so there is no request to approve.");
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const { data, error: e } = await (supabase.auth as any).oauth
          .getAuthorizationDetails(authorizationId);
        if (e) throw e;
        // Already consented to these scopes — Supabase hands back a redirect instead of details.
        if (data && "redirect_url" in data) {
          window.location.href = (data as { redirect_url: string }).redirect_url;
          return;
        }
        setDetails(data as Details);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [authLoading, user, authorizationId, navigate]);

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      const api = (supabase.auth as any).oauth;
      const { data, error: e } = approve
        ? await api.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
        : await api.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
      if (e) throw e;
      const url = (data as { redirect_url?: string })?.redirect_url ?? "";
      // Show the outcome BEFORE navigating. The redirect leaves for the client's own origin
      // (claude.ai), so the consent tab would otherwise sit on a spinner and read as "nothing
      // happened" even though approval succeeded and the client is already receiving its token.
      setDone({ approved: approve, url });
      if (url) window.location.assign(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <Card>
          <CardHeader className="space-y-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className={done.approved ? "h-6 w-6 text-emerald-600 dark:text-emerald-400" : "h-6 w-6 text-muted-foreground"} />
              <CardTitle>{done.approved ? "Approved" : "Request denied"}</CardTitle>
            </div>
            <CardDescription>
              {done.approved
                ? "Claude Code can now act as you in BBQS. Return to your terminal — it should already show the connection as authorized."
                : "Nothing was granted. You can close this tab."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {done.approved && done.url && (
              <>
                <p className="text-xs text-muted-foreground">
                  If your terminal is still waiting, finish the hand-off here:
                </p>
                <Button asChild className="w-full">
                  <a href={done.url}>Return to Claude Code</a>
                </Button>
              </>
            )}
            {!done.url && (
              <p className="text-xs text-muted-foreground">You can close this tab and return to Claude Code.</p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (authLoading || loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !details) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <Card>
          <CardHeader>
            <CardTitle>Authorization request cannot be shown</CardTitle>
            <CardDescription>{error ?? "No authorization details were returned."}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => navigate("/dashboard")}>Back to dashboard</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const scopes = details.scope.split(/\s+/).filter(Boolean);
  let host = details.redirect_uri;
  try { host = new URL(details.redirect_uri).host || details.redirect_uri; } catch { /* show it raw */ }

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center gap-3">
            {details.client.logo_uri
              ? <img src={details.client.logo_uri} alt="" className="h-10 w-10 rounded" />
              : <ShieldCheck className="h-10 w-10 text-muted-foreground" />}
            <div>
              <CardTitle className="text-lg">{details.client.name || "An application"}</CardTitle>
              <CardDescription>wants to act as you in BBQS</CardDescription>
            </div>
          </div>
          <CardDescription>
            Signed in as <span className="font-medium text-foreground">{details.user.email}</span>.
            Anything it does will be recorded under your name.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="rounded-md border p-3 text-sm">
            <div className="text-muted-foreground">It will be able to do what you can do</div>
            <p className="mt-1">
              This grants your own level of access — no more. If you are a curator, that includes
              onboarding and offboarding members and writing to the knowledge graph.
            </p>
            {scopes.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-muted-foreground">
                {scopes.map((s) => <li key={s}><code>{s}</code></li>)}
              </ul>
            )}
          </div>

          <div className="text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <ExternalLink className="h-3 w-3" />
              Returns you to <code className="text-foreground">{host}</code>
            </div>
            <p className="mt-2">
              Only approve this if you started it. If a page you did not open sent you here, deny.
            </p>
          </div>

          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => decide(true)} disabled={busy}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Approve
            </Button>
            <Button className="flex-1" variant="outline" onClick={() => decide(false)} disabled={busy}>
              Deny
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
