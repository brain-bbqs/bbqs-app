import { useSearchParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageMeta } from "@/components/PageMeta";
import { SystemAlertsBanner } from "@/components/admin/SystemAlertsBanner";
import { ShieldCheck, UserPlus, AlertTriangle, FolderPlus, Wallet } from "lucide-react";
import AdminUsers from "./AdminUsers";
import AdminAccessRequests from "./AdminAccessRequests";
import { AddProjectByGrantDialog } from "@/components/admin/AddProjectByGrantDialog";
import { BudgetsPanel } from "@/components/admin/BudgetsPanel";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

const VALID_TABS = ["alerts", "budgets", "users", "access-requests", "add-project"] as const;
type TabKey = (typeof VALID_TABS)[number];

export default function AdminConsole() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") as TabKey | null;
  const tab: TabKey = requested && VALID_TABS.includes(requested) ? requested : "alerts";

  const onChange = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", v);
    setParams(next, { replace: true });
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <PageMeta title="Admin Console" description="System alerts, user roles, and access requests" />

      <div className="mb-6">
        <h1 className="text-3xl font-bold text-foreground mb-1">Admin Console</h1>
        <p className="text-sm text-muted-foreground">
          Centralized administration: monitor system alerts, manage user tiers, and review access requests.
        </p>
      </div>

      <Tabs value={tab} onValueChange={onChange} className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="alerts" className="gap-1.5">
            <AlertTriangle className="h-4 w-4" />
            System Alerts
          </TabsTrigger>
          <TabsTrigger value="budgets" className="gap-1.5">
            <Wallet className="h-4 w-4" />
            Budgets
          </TabsTrigger>
          <TabsTrigger value="users" className="gap-1.5">
            <ShieldCheck className="h-4 w-4" />
            User Roles
          </TabsTrigger>
          <TabsTrigger value="access-requests" className="gap-1.5">
            <UserPlus className="h-4 w-4" />
            Access Requests
          </TabsTrigger>
          <TabsTrigger value="add-project" className="gap-1.5">
            <FolderPlus className="h-4 w-4" />
            Add Project
          </TabsTrigger>
        </TabsList>

        <TabsContent value="alerts" className="mt-0">
          <SystemAlertsBanner />
          <p className="text-sm text-muted-foreground mt-4">
            Active alerts are shown above. When there are no unresolved alerts, this section is empty.
          </p>
        </TabsContent>

        <TabsContent value="budgets" className="mt-0">
          <BudgetsPanel />
        </TabsContent>

        <TabsContent value="users" className="mt-0">
          <AdminUsers embedded />
        </TabsContent>

        <TabsContent value="access-requests" className="mt-0">
          <AdminAccessRequests embedded />
        </TabsContent>

        <TabsContent value="add-project" className="mt-0">
          <div className="rounded-lg border border-border bg-card p-6">
            <h2 className="text-lg font-semibold text-foreground mb-1">Add a project by NIH award ID</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Look up an NIH RePORTER award number (e.g. <code className="text-xs">R34DA059510</code>)
              and seed the grant, contact PI, and institution into BBQS. Project questionnaire fields
              remain empty for the team to complete.
            </p>
            <AddProjectByGrantDialog
              trigger={
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Add project from RePORTER
                </Button>
              }
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}