import { useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useUserTier } from "@/hooks/useUserTier";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Loader2, Lock, Mail, Check, X, UserPlus, AlertTriangle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { PageMeta } from "@/components/PageMeta";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Status = "pending" | "approved" | "dismissed";

interface AccessRequest {
  id: string;
  email: string;
  globus_name: string | null;
  globus_subject: string | null;
  message: string | null;
  status: Status;
  created_at: string;
  reviewed_at: string | null;
  review_notes: string | null;
  full_name?: string | null;
  institution?: string | null;
  requested_role?: string | null;
  /** Requester-declared BBQS tie: grant number, PI/lab name, or an explicit
   *  "not affiliated" declaration. Null on rows filed before this field existed
   *  and on Globus auto-filed rows (which know only the email). */
  association?: string | null;
}

/** A BBQS/NIH award number stated in the free-text association, if there is one — lets
 *  "Approve & onboard" hand the grant straight to the wizard instead of making the admin re-type
 *  it. Matches e.g. U24MH136628 / 1R61MH135106-01. Kept prefix- and suffix-tolerant on purpose:
 *  a requester may type the full award number even though grants.grant_number now stores the
 *  stable core (migration 20260810170000), and the grant lookup strips both ends anyway. */
function grantNumberFrom(association?: string | null): string | null {
  const m = (association ?? "").match(/\b\d?[A-Z]\d{2}[A-Z]{2}\d{5,6}\b/i);
  return m ? m[0].toUpperCase() : null;
}

interface NameCollision {
  request: AccessRequest;
  existing: {
    id: string;
    name: string;
    email: string | null;
    secondary_emails: string[] | null;
  };
  email: string;
}

interface AdminAccessRequestsProps {
  embedded?: boolean;
}

export default function AdminAccessRequests({ embedded = false }: AdminAccessRequestsProps = {}) {
  const tier = useUserTier();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [collision, setCollision] = useState<NameCollision | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AccessRequest | null>(null);
  const navigate = useNavigate();

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ["access-requests"],
    enabled: tier.isCurator,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("access_requests")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as AccessRequest[];
    },
  });

  // The "Person" name on a request is the value captured WHEN THE REQUEST WAS FILED
  // (globus_name — often a Globus username like "test-user-tier1"). Once the person
  // is on the investigators roster, the authoritative name is investigators.name.
  // Resolve request email → investigator name so the console shows the real name
  // for every row (no data migration needed).
  const requestEmails = useMemo(
    () => Array.from(new Set(requests.map((r) => r.email))),
    [requests],
  );
  const { data: invNameByEmail = {} } = useQuery({
    queryKey: ["access-request-investigator-names", requestEmails],
    enabled: tier.isCurator && requestEmails.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("investigators")
        .select("name, email")
        .in("email", requestEmails);
      const map: Record<string, string> = {};
      for (const row of data ?? []) {
        const e = (row as { email?: string | null }).email;
        const n = (row as { name?: string | null }).name;
        if (e && n) map[e.toLowerCase()] = n;
      }
      return map;
    },
  });
  // Authoritative display name for a request: roster name → filed full_name → globus_name.
  const personName = (r: AccessRequest) =>
    invNameByEmail[r.email.toLowerCase()] || r.full_name || r.globus_name || "—";

  const sendApprovalEmail = async (to: string, name: string, note?: string) => {
    try {
      const { data, error } = await supabase.functions.invoke(
        "send-access-approved-email",
        { body: { to, name, note } },
      );
      if (error || (data && data.success === false)) {
        console.error("Approval email failed:", error || data?.error);
        toast.warning(
          "Approved, but notification email failed to send. Please contact the requester manually.",
        );
        return false;
      }
      return true;
    } catch (err) {
      console.error("Approval email exception:", err);
      toast.warning(
        "Approved, but notification email failed to send. Please contact the requester manually.",
      );
      return false;
    }
  };

  const setStatus = async (id: string, next: Status, notes?: string) => {
    setBusyId(id);
    try {
      const { error } = await supabase
        .from("access_requests")
        .update({
          status: next,
          reviewed_at: new Date().toISOString(),
          review_notes: notes ?? null,
        })
        .eq("id", id);
      if (error) throw error;
      toast.success(next === "approved" ? "Marked as approved" : "Dismissed");
      queryClient.invalidateQueries({ queryKey: ["access-requests"] });
    } catch (err: any) {
      toast.error(err.message ?? "Failed to update request");
    } finally {
      setBusyId(null);
    }
  };

  const approveAndInvite = async (r: AccessRequest) => {
    setBusyId(r.id);
    try {
      const name = (r.full_name || r.globus_name || r.email.split("@")[0] || "Unknown").trim();
      const email = r.email.toLowerCase();

      // 1. Match by email (primary or secondary)
      const { data: existingByEmail } = await supabase
        .from("investigators")
        .select("id, name")
        .or(`email.ilike.${email},secondary_emails.cs.{${email}}`)
        .maybeSingle();

      let alreadyListed = !!existingByEmail;
      const existingName = existingByEmail?.name as string | undefined;

      if (!existingByEmail) {
        // 2. Try insert; on name collision, prompt curator
        const { error: invErr } = await supabase
          .from("investigators")
          .insert({ name, email });

        if (invErr) {
          const isNameDup =
            invErr.code === "23505" &&
            (invErr.message?.includes("investigators_name_key") ||
              invErr.message?.toLowerCase().includes("name"));

          if (isNameDup) {
            const { data: nameMatch } = await supabase
              .from("investigators")
              .select("id, name, email, secondary_emails")
              .ilike("name", name)
              .maybeSingle();

            if (nameMatch) {
              setCollision({ request: r, existing: nameMatch, email });
              setBusyId(null);
              return;
            }
          }
          throw invErr;
        }
      }

      const { error } = await supabase
        .from("access_requests")
        .update({
          status: "approved",
          reviewed_at: new Date().toISOString(),
          review_notes: alreadyListed
            ? `Already listed as "${existingName}" in investigators directory`
            : "Added to investigators directory",
        })
        .eq("id", r.id);
      if (error) throw error;

      toast.success(
        alreadyListed
          ? `Approved — email already linked to "${existingName}"`
          : "Approved and invited. They can sign in via Globus now.",
      );
      await sendApprovalEmail(
        email,
        alreadyListed ? (existingName || name) : name,
        alreadyListed
          ? `Your email is already linked to the investigator profile "${existingName}".`
          : "You've been added to the investigators directory.",
      );
      queryClient.invalidateQueries({ queryKey: ["access-requests"] });
    } catch (err: any) {
      console.error(err);
      toast.error(err.message ?? "Failed to approve and invite");
    } finally {
      setBusyId(null);
    }
  };

  // "Approve & onboard" — FULL provisioning, in the ADMIN CONSOLE rather than the agent.
  //
  // This used to open the agent with ?ask=Onboard <name> (<email>), handing a deterministic task to
  // an LLM that then had to re-derive every field from a sentence. The console's Onboard wizard is
  // the deterministic path, and the request already holds everything the wizard needs — name, email,
  // institution, requested_role, and the association naming their PI or grant. So carry those
  // straight into Smart fill instead of round-tripping through prose.
  //
  // The request id rides along so the wizard can mark THIS request approved once the onboard
  // succeeds. Previously nothing closed the loop from the console side: the agent workflow
  // auto-cleared the request (workflow.ts Step 1b) but a console onboard did not, leaving a pending
  // row for an already-provisioned member.
  const approveAndOnboard = (r: AccessRequest) => {
    const name = (r.full_name || r.globus_name || r.email.split("@")[0] || "Unknown").trim();
    const parts = [name, r.email.toLowerCase()];
    if (r.requested_role) parts.push(r.requested_role);
    if (r.institution) parts.push(r.institution);
    // Prefer an explicit award number when the association states one — Smart fill resolves
    // "grant <number>" far more reliably than a lab name. A PI/lab name rides along as prose for
    // grant_hint to match on. An explicit "not affiliated" declaration is deliberately dropped:
    // it is meaningful to a REVIEWER but would only mislead the grant search.
    const grant = grantNumberFrom(r.association);
    const assoc = (r.association ?? "").trim();
    if (grant) parts.push(`grant ${grant}`);
    else if (assoc && !/^not affiliated/i.test(assoc)) parts.push(`works with ${assoc}`);
    navigate(
      `/admin?tab=onboarding&prefill=${encodeURIComponent(parts.join(", "))}` +
        `&request=${encodeURIComponent(r.id)}`,
    );
    toast.info("Opening the onboard wizard with this request pre-filled — review the fields, then submit.");
  };

  const linkAsSecondaryEmail = async () => {
    if (!collision) return;
    const { request, existing, email } = collision;
    setBusyId(request.id);
    try {
      const current = existing.secondary_emails ?? [];
      const next = Array.from(new Set([...current.map((e) => e.toLowerCase()), email]));

      const { error: updErr } = await supabase
        .from("investigators")
        .update({ secondary_emails: next })
        .eq("id", existing.id);
      if (updErr) throw updErr;

      const { error } = await supabase
        .from("access_requests")
        .update({
          status: "approved",
          reviewed_at: new Date().toISOString(),
          review_notes: `Linked ${email} as secondary email on existing investigator "${existing.name}"`,
        })
        .eq("id", request.id);
      if (error) throw error;

      toast.success(`Linked ${email} to "${existing.name}". They can sign in via Globus now.`);
      await sendApprovalEmail(
        email,
        existing.name,
        `Your email has been linked to the existing investigator profile "${existing.name}".`,
      );
      setCollision(null);
      queryClient.invalidateQueries({ queryKey: ["access-requests"] });
    } catch (err: any) {
      console.error(err);
      toast.error(err.message ?? "Failed to link secondary email");
    } finally {
      setBusyId(null);
    }
  };

  const createWithDisambiguatedName = async () => {
    if (!collision) return;
    const { request, email } = collision;
    setBusyId(request.id);
    try {
      const baseName = (request.full_name || request.globus_name || email.split("@")[0]).trim();
      const institution = request.institution?.trim();
      const disambiguated = institution ? `${baseName} (${institution})` : `${baseName} (${email})`;

      const { error: invErr } = await supabase
        .from("investigators")
        .insert({ name: disambiguated, email });
      if (invErr) throw invErr;

      const { error } = await supabase
        .from("access_requests")
        .update({
          status: "approved",
          reviewed_at: new Date().toISOString(),
          review_notes: `Added to investigators as "${disambiguated}" (name collision resolved)`,
        })
        .eq("id", request.id);
      if (error) throw error;

      toast.success(`Added as "${disambiguated}". They can sign in via Globus now.`);
      await sendApprovalEmail(
        email,
        disambiguated,
        `You've been added to the investigators directory as "${disambiguated}".`,
      );
      setCollision(null);
      queryClient.invalidateQueries({ queryKey: ["access-requests"] });
    } catch (err: any) {
      console.error(err);
      toast.error(err.message ?? "Failed to create investigator");
    } finally {
      setBusyId(null);
    }
  };

  const revokeAccess = async (r: AccessRequest) => {
    setBusyId(r.id);
    try {
      const email = r.email.toLowerCase();

      // Look up the investigator linked to this email (primary or secondary)
      const { data: inv } = await supabase
        .from("investigators")
        .select("id, name, user_id, secondary_emails")
        .or(`email.ilike.${email},secondary_emails.cs.{${email}}`)
        .maybeSingle();

      let note = "Access revoked by curator.";

      if (inv) {
        if (inv.user_id) {
          // They've signed in — don't delete the investigator record, just note it.
          note += ` Investigator "${inv.name}" remains in the directory (already signed in via Globus). Remove their user role separately if needed.`;
        } else {
          // Not yet linked to an auth user — safe to clean up.
          const isPrimary = true; // we don't know which matched; check secondary
          const secondaries = (inv.secondary_emails ?? []).map((e) => e.toLowerCase());
          if (secondaries.includes(email)) {
            // Remove just the secondary email
            const next = secondaries.filter((e) => e !== email);
            const { error: updErr } = await supabase
              .from("investigators")
              .update({ secondary_emails: next })
              .eq("id", inv.id);
            if (updErr) throw updErr;
            note += ` Removed ${email} from secondary emails on "${inv.name}".`;
          } else {
            // Email is the primary — delete the investigator (only allowed if user_id is null)
            const { error: delErr } = await supabase
              .from("investigators")
              .delete()
              .eq("id", inv.id);
            if (delErr) throw delErr;
            note += ` Removed "${inv.name}" from the investigators directory.`;
          }
        }
      } else {
        note += " No matching investigator entry found.";
      }

      const { error } = await supabase
        .from("access_requests")
        .update({
          status: "dismissed",
          reviewed_at: new Date().toISOString(),
          review_notes: note,
        })
        .eq("id", r.id);
      if (error) throw error;

      toast.success("Access revoked");
      setRevokeTarget(null);
      queryClient.invalidateQueries({ queryKey: ["access-requests"] });
    } catch (err: any) {
      console.error(err);
      toast.error(err.message ?? "Failed to revoke access");
    } finally {
      setBusyId(null);
    }
  };

  if (tier.isLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!tier.isCurator) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16">
        <Card>
          <CardContent className="p-8 text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-5">
              <Lock className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-2xl font-bold mb-2">Reviewer access required</h1>
            <p className="text-sm text-muted-foreground mb-6">
              This page is restricted to Tier 1 admins and Tier 2 curators.
            </p>
            <Button asChild variant="outline">
              <Link to="/">Back to home</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const pending = requests.filter((r) => r.status === "pending");
  const decided = requests.filter((r) => r.status !== "pending");

  const renderRow = (r: AccessRequest, withActions: boolean) => (
    <TableRow key={r.id}>
      <TableCell>
        <div className="font-medium text-foreground">
          {personName(r)}
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <Mail className="h-3 w-3" /> {r.email}
        </div>
        {r.institution && (
          <div className="text-xs text-muted-foreground mt-1">{r.institution}</div>
        )}
        {r.requested_role && (
          <Badge variant="outline" className="mt-1 text-xs font-normal">
            {r.requested_role}
          </Badge>
        )}
        {/* The declared grant/PI tie — the reviewer's basis for approving and for
            routing them to the right roster. Flagged when absent (legacy or
            Globus auto-filed rows) so it reads as "unknown", never as "none". */}
        {r.association ? (
          <div className="text-xs mt-1">
            <span className="text-muted-foreground">Association: </span>
            <span className="text-foreground">{r.association}</span>
          </div>
        ) : (
          <div className="text-xs text-amber-600 mt-1">Association not stated — ask before approving</div>
        )}
        {r.message && (
          <div className="text-xs text-muted-foreground mt-1 italic line-clamp-2 max-w-md">
            "{r.message}"
          </div>
        )}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {format(new Date(r.created_at), "MMM d, yyyy h:mm a")}
      </TableCell>
      <TableCell>
        {r.status === "pending" ? (
          <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30">
            Pending
          </Badge>
        ) : r.status === "approved" ? (
          <Badge variant="secondary">
            Approved
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            Dismissed
          </Badge>
        )}
      </TableCell>
      {withActions && (
        <TableCell className="text-right">
          <div className="inline-flex items-center gap-2">
            {busyId === r.id && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
            <Button
              size="sm"
              variant="default"
              onClick={() => approveAndInvite(r)}
              disabled={busyId === r.id}
              title="Adds the person to the investigators directory and marks the request approved. They can then sign in via Globus."
            >
              <Check className="h-3.5 w-3.5 mr-1" />
              Approve & invite
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={() => approveAndOnboard(r)}
              disabled={busyId === r.id}
              title="Open the onboarding agent pre-filled to FULLY provision them (mailing lists + welcome + role). This request clears automatically when onboarding completes."
            >
              <UserPlus className="h-3.5 w-3.5 mr-1" />
              Approve & onboard
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setStatus(r.id, "dismissed")}
              disabled={busyId === r.id}
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Dismiss
            </Button>
          </div>
        </TableCell>
      )}
    </TableRow>
  );

  return (
    <div className={embedded ? "" : "max-w-6xl mx-auto px-4 py-8"}>
      {!embedded && (
        <PageMeta title="Access Requests — Admin" description="Review pending Globus sign-in attempts" />
      )}

      <div className="mb-6">
        {!embedded && (
          <h1 className="text-3xl font-bold text-foreground mb-1">Access Requests</h1>
        )}
        <p className="text-sm text-muted-foreground">
          Sign-up requests from the public form and Globus sign-in attempts from people whose
          email isn't on the consortium roster. <strong>Approve &amp; invite</strong> adds them
          to the investigators directory (duplicate-safe) so they can sign in via Globus.{" "}
          <strong>Approve &amp; onboard</strong> opens the agent to fully provision a consortium
          member (mailing lists, welcome email, role) and auto-clears the request when done.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pending.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Approved</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {requests.filter((r) => r.status === "approved").length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Dismissed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {requests.filter((r) => r.status === "dismissed").length}
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending">Pending ({pending.length})</TabsTrigger>
          <TabsTrigger value="decided">Decided ({decided.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="pending">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserPlus className="h-4 w-4" />
                Awaiting decision
              </CardTitle>
              <CardDescription>
                <strong>Approve &amp; invite</strong> adds the person to the{" "}
                <code className="font-mono">investigators</code> directory (duplicate-safe) so
                they can sign in via Globus. <strong>Approve &amp; onboard</strong> hands off to
                the agent to fully provision a consortium member and auto-clears the request.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="py-12 flex justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : pending.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No pending requests. ✨
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Person</TableHead>
                        <TableHead>Requested</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>{pending.map((r) => renderRow(r, true))}</TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="decided">
          <Card>
            <CardHeader>
              <CardTitle>Decided requests</CardTitle>
            </CardHeader>
            <CardContent>
              {decided.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No decided requests yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Person</TableHead>
                        <TableHead>Requested</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {decided.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>
                            <div className="font-medium text-foreground">
                              {personName(r)}
                            </div>
                            <div className="text-xs text-muted-foreground flex items-center gap-1">
                              <Mail className="h-3 w-3" /> {r.email}
                            </div>
                            {r.institution && (
                              <div className="text-xs text-muted-foreground mt-1">
                                {r.institution}
                              </div>
                            )}
                            {r.review_notes && (
                              <div className="text-xs text-muted-foreground mt-1 italic line-clamp-2 max-w-md">
                                {r.review_notes}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {format(new Date(r.created_at), "MMM d, yyyy h:mm a")}
                          </TableCell>
                          <TableCell>
                            {r.status === "approved" ? (
                              <Badge variant="secondary">Approved</Badge>
                            ) : (
                              <Badge variant="outline" className="text-muted-foreground">
                                Dismissed
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {r.status === "approved" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setRevokeTarget(r)}
                                disabled={busyId === r.id}
                              >
                                {busyId === r.id ? (
                                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                                )}
                                Revoke
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Revoke access?
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-2">
              <span className="block">
                This will mark{" "}
                <strong>{revokeTarget ? (invNameByEmail[revokeTarget.email.toLowerCase()] || revokeTarget.full_name || revokeTarget.globus_name || revokeTarget.email) : ""}</strong>{" "}
                as dismissed and remove their invite from the investigators directory if they
                haven't signed in yet.
              </span>
              <span className="block text-xs text-muted-foreground">
                If the user has already signed in via Globus, their investigator profile is kept
                and you must remove their user role manually.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevokeTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => revokeTarget && revokeAccess(revokeTarget)}
              disabled={busyId === revokeTarget?.id}
            >
              {busyId === revokeTarget?.id && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Revoke access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!collision} onOpenChange={(open) => !open && setCollision(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-accent-foreground" />
              Name already exists in directory
            </DialogTitle>
            <DialogDescription>
              An investigator with this name is already in the consortium roster. Choose how to
              resolve this so the requester can sign in.
            </DialogDescription>
          </DialogHeader>

          {collision && (
            <div className="space-y-3 text-sm">
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  Existing investigator
                </div>
                <div className="font-medium text-foreground">{collision.existing.name}</div>
                <div className="text-xs text-muted-foreground break-all">
                  Primary: {collision.existing.email || "—"}
                </div>
                {collision.existing.secondary_emails &&
                  collision.existing.secondary_emails.length > 0 && (
                    <div className="text-xs text-muted-foreground break-all">
                      Secondary: {collision.existing.secondary_emails.join(", ")}
                    </div>
                  )}
              </div>

              <div className="rounded-md border border-border bg-muted/40 p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  Requester
                </div>
                <div className="font-medium text-foreground">
                  {collision.request.full_name || collision.request.globus_name || "—"}
                </div>
                <div className="text-xs text-muted-foreground break-all">{collision.email}</div>
                {collision.request.institution && (
                  <div className="text-xs text-muted-foreground break-all">
                    {collision.request.institution}
                  </div>
                )}
              </div>

              <p className="text-xs text-muted-foreground pt-1">
                If this is the <strong>same person</strong> using a different email, link the
                email as a secondary sign-in method. If they're a <strong>different person</strong>{" "}
                who happens to share the name, create a separate row with a disambiguated name.
              </p>
            </div>
          )}

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => setCollision(null)}
              disabled={!!busyId}
            >
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={createWithDisambiguatedName}
              disabled={!!busyId}
            >
              Different person — create new
            </Button>
            <Button onClick={linkAsSecondaryEmail} disabled={!!busyId}>
              {busyId && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Same person — link email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}