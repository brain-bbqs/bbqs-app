import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Building2, FileText, FolderOpen, Users, UserCog, ArrowRight } from "lucide-react";

interface Props {
  investigatorId: string | null;
  workingGroups: string[];
  fullName?: string | null;
  email?: string | null;
}

function greeting(date = new Date()) {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

export function DashboardHero({ investigatorId, workingGroups, fullName, email }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard-hero", investigatorId],
    enabled: !!investigatorId,
    queryFn: async () => {
      const [{ data: inv }, { data: links }] = await Promise.all([
        supabase
          .from("investigators")
          .select("name, role, institution")
          .eq("id", investigatorId!)
          .maybeSingle(),
        supabase.from("grant_investigators").select("grant_id, role").eq("investigator_id", investigatorId!),
      ]);

      const grantIds = [...new Set((links ?? []).map((l) => l.grant_id).filter(Boolean))] as string[];

      let publications = 0;
      if (grantIds.length) {
        const { data: projects } = await supabase.from("projects").select("id").in("grant_id", grantIds);
        const projectIds = (projects ?? []).map((p) => p.id);
        if (projectIds.length) {
          const { count } = await supabase
            .from("project_publications")
            .select("publication_id", { count: "exact", head: true })
            .in("project_id", projectIds);
          publications = count ?? 0;
        }
      }

      const roles = [...new Set((links ?? []).map((l) => l.role).filter(Boolean))] as string[];
      return {
        name: inv?.name ?? null,
        role: inv?.role ?? null,
        institution: inv?.institution ?? null,
        grants: grantIds.length,
        publications,
        grantRoles: roles,
      };
    },
  });

  const displayName = data?.name || fullName || email?.split("@")[0] || "there";
  const firstName = displayName.split(/\s+/)[0];

  const stats = [
    { label: "Projects & grants", value: data?.grants ?? 0, icon: FolderOpen, to: "/projects" },
    { label: "Working groups", value: workingGroups.length, icon: Users, to: "/working-groups" },
    { label: "Publications", value: data?.publications ?? 0, icon: FileText, to: "/publications" },
  ];

  return (
    <Card className="mb-6 overflow-hidden border-border">
      <CardContent className="p-6">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar className="h-14 w-14 border border-border">
            <AvatarFallback className="bg-primary/10 text-primary font-semibold">
              {initials(displayName) || "?"}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-foreground">
              {greeting()}, {firstName}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {data?.role && (
                <span className="inline-flex items-center gap-1.5 capitalize">
                  <UserCog className="h-3.5 w-3.5" />
                  {data.role.replace(/_/g, " ")}
                </span>
              )}
              {data?.institution && (
                <span className="inline-flex items-center gap-1.5">
                  <Building2 className="h-3.5 w-3.5" />
                  {data.institution}
                </span>
              )}
              {!investigatorId && <span>Your account isn&apos;t linked to an investigator record yet.</span>}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {isLoading && investigatorId ? (
                <Skeleton className="h-5 w-40" />
              ) : workingGroups.length ? (
                <>
                  <span className="text-xs uppercase tracking-wide text-muted-foreground mr-1">
                    Working groups
                  </span>
                  {workingGroups.map((g) => (
                    <Badge key={g} variant="secondary">
                      {g}
                    </Badge>
                  ))}
                </>
              ) : (
                <span className="text-sm text-muted-foreground">
                  No working group assigned yet — ask an admin to add you.
                </span>
              )}
            </div>

            {!!data?.grantRoles.length && (
              <p className="mt-2 text-xs text-muted-foreground">
                Assigned as{" "}
                <span className="capitalize text-foreground">
                  {data.grantRoles.map((r) => r.replace(/_/g, " ")).join(", ")}
                </span>{" "}
                on your linked grants.
              </p>
            )}
          </div>

          <Button asChild variant="outline" size="sm">
            <Link to="/profile">
              View profile <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {stats.map((s) => (
            <Link
              key={s.label}
              to={s.to}
              className="rounded-lg border border-border bg-muted/40 p-3 transition-colors hover:bg-muted"
            >
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <s.icon className="h-3.5 w-3.5 text-primary" />
                {s.label}
              </div>
              <p className="mt-1 text-2xl font-semibold text-foreground">
                {isLoading && investigatorId ? <Skeleton className="h-7 w-10" /> : s.value}
              </p>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
