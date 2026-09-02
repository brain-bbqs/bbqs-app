import { useState, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, Globe } from "lucide-react";
import { OAUTH_RETURN_KEY } from "./OAuthConsent";

/** Where to send someone after sign-in. An OAuth consent request parks its URL here first, because
 *  losing it strands the client on an authorization that never completes. */
function afterSignIn(): string {
  const back = sessionStorage.getItem(OAUTH_RETURN_KEY);
  if (back) {
    sessionStorage.removeItem(OAUTH_RETURN_KEY);
    return back;
  }
  return "/dashboard";
}

export default function Auth() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const [globusLoading, setGlobusLoading] = useState(false);

  // Redirect if already logged in
  useEffect(() => {
    if (user) navigate(afterSignIn());
  }, [user, navigate]);

  // Handle Globus callback — token_hash comes as a query param from the edge function redirect
  useEffect(() => {
    const tokenHash = searchParams.get("token_hash");
    const globusError = searchParams.get("globus_error");
    const globusName = searchParams.get("globus_name");
    const globusEmail = searchParams.get("globus_email");
    const globusSubject = searchParams.get("globus_subject");

    if (globusError) {
      const errorMessages: Record<string, string> = {
        token_exchange_failed: "Failed to exchange Globus authorization code.",
        userinfo_failed: "Failed to retrieve your Globus profile.",
        no_email: "No email was returned from Globus.",
        domain_not_allowed: "Access is restricted to BBQS consortium university emails.",
        not_a_member:
          "Your email isn't on the BBQS consortium roster yet. We've notified the admins — you'll get an email once your account is approved.",
        create_user_failed: "Failed to create your account.",
        session_failed: "Failed to generate a session.",
      };
      if (globusError === "not_a_member") {
        // Route into the single intake form with the Globus identity prefilled, so
        // the person completes ONE request (name, institution, role) instead of us
        // silently filing a bare row behind their back.
        const intakeParams = new URLSearchParams();
        if (globusEmail) intakeParams.set("email", globusEmail);
        if (globusName) intakeParams.set("name", globusName);
        if (globusSubject) intakeParams.set("subject", globusSubject);
        const intakeTo = `/request-access${
          intakeParams.toString() ? `?${intakeParams.toString()}` : ""
        }`;
        toast.info(errorMessages.not_a_member, {
          duration: 12000,
          action: {
            label: "Complete intake form",
            onClick: () => navigate(intakeTo),
          },
        });
      } else {
        toast.error(errorMessages[globusError] || "Globus sign-in failed.");
      }
      window.history.replaceState({}, "", "/auth");
      return;
    }

    if (tokenHash) {
      handleTokenHash(tokenHash, globusName, globusEmail);
    }
  }, [searchParams]);

  const handleTokenHash = async (tokenHash: string, name?: string | null, email?: string | null) => {
    setGlobusLoading(true);
    try {
      const { error: otpError } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: "magiclink",
      });

      if (otpError) {
        throw otpError;
      }

      toast.success(`Welcome, ${name || email || ""}!`);
      window.history.replaceState({}, "", "/auth");
      navigate(afterSignIn());
    } catch (err: any) {
      console.error("Globus callback error:", err);
      toast.error(err.message || "Globus sign-in failed");
      window.history.replaceState({}, "", "/auth");
    } finally {
      setGlobusLoading(false);
    }
  };

  const handleGlobusLogin = async () => {
    setGlobusLoading(true);
    try {
      const redirectUri = `${window.location.origin}/auth`;
      const { data, error } = await supabase.functions.invoke("globus-auth", {
        body: { action: "login", redirect_uri: redirectUri },
      });

      if (error || data?.error) {
        throw new Error(data?.error || error?.message || "Failed to start Globus login");
      }

      window.location.href = data.url;
    } catch (err: any) {
      toast.error(err.message || "Failed to start Globus login");
      setGlobusLoading(false);
    }
  };

  // Show loading if processing callback
  if (globusLoading && (searchParams.get("token_hash") || searchParams.get("code"))) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-12 flex flex-col items-center gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Signing in with Globus…</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Welcome to BBQS</CardTitle>
          <CardDescription>
            Sign in with your institutional Globus account to access the consortium platform.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            type="button"
            className="w-full h-12 text-base"
            onClick={handleGlobusLogin}
            disabled={globusLoading}
          >
            {globusLoading ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            ) : (
              <Globe className="mr-2 h-5 w-5" />
            )}
            Sign in with Globus
          </Button>

          <p className="text-xs text-center text-muted-foreground">
            Access is restricted to BBQS consortium affiliates. Sign in using your university identity through Globus.
          </p>

          <div className="pt-2 text-center text-sm text-muted-foreground border-t border-border">
            <span>Don't have access yet?</span>{" "}
            <Link
              to="/request-access"
              className="text-primary hover:underline font-medium"
            >
              Request an account
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
