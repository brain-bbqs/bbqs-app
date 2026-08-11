import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { isPreviewMode } from "@/lib/preview-mode";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Minimal fake user object for preview mode.
// The id must be a valid UUID: it is sent to PostgREST in `id=eq.<uuid>`
// filters (profiles, dashboard layouts, ...) and a non-UUID makes every one
// of those requests fail with a 400 on every page load.
const PREVIEW_USER = {
  id: "00000000-0000-0000-0000-000000000000",
  email: "preview@lovable.app",
  user_metadata: { full_name: "Preview User" },
  app_metadata: {},
  aud: "authenticated",
  created_at: new Date().toISOString(),
} as unknown as User;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const preview = isPreviewMode();

  useEffect(() => {
    const applyAuthState = (nextSession: Session | null) => {
      setSession(nextSession);
      if (nextSession?.user) {
        setUser(nextSession.user);
      } else if (preview) {
        setUser(PREVIEW_USER);
      } else {
        setUser(null);
      }
      setLoading(false);
    };

    if (preview) {
      setUser(PREVIEW_USER);
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        applyAuthState(session);
      }
    );

    supabase.auth.getSession().then(({ data: { session } }) => {
      applyAuthState(session);
    });

    return () => subscription.unsubscribe();
  }, [preview]);

  const signOut = async () => {
    if (preview && !session) return;
    await supabase.auth.signOut();
    // Revoke Globus session so the next login prompts for identity selection
    window.location.href = "https://auth.globus.org/v2/web/logout?redirect_uri=" + encodeURIComponent(window.location.origin + "/auth");
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    // Only use the fake auth fallback for true local development preview.
    if (isPreviewMode()) {
      return {
        user: PREVIEW_USER,
        session: null,
        loading: false,
        signOut: async () => {},
      };
    }
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
