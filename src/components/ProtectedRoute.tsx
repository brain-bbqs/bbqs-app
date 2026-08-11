import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

/** Route-level sign-in guard (issue #189, contributed by @samriddhighosh in PR #191).
 *
 *  WHY route-level, when pages already gate themselves: they mostly do, but not uniformly.
 *  AdminAccessRequests, Profile and InternalCoordination each check useUserTier/useAuth and render a
 *  lock, whereas AdminConsole has NO page-level check at all — its shell renders for anyone and only
 *  the individual panels gate on isCurator. So the page told an anonymous visitor which admin tabs
 *  exist before refusing them. A guard at the route removes that inconsistency in one place instead
 *  of relying on every future page remembering to gate itself.
 *
 *  This is authentication only — "are you signed in". AUTHORIZATION (curator/admin tier) stays with
 *  the pages and, authoritatively, with RLS: a route guard is a UX affordance and must never be the
 *  thing that protects data.
 *
 *  `loading` must be honoured, or the guard bounces a signed-in user to /auth during the initial
 *  session restore. `state.from` lets /auth return them where they were headed.
 */
export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
