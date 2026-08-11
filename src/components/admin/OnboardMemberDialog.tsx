import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Check, Mail, X, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { edgeError } from "@/lib/edgeError";

const ROLES: { value: string; label: string }[] = [
  { value: "contact_pi", label: "Contact PI" },
  { value: "co_pi", label: "Co-PI" },
  { value: "mpi", label: "Multiple PI" },
  { value: "co-investigator", label: "Co-Investigator" },
  { value: "postdoc", label: "Postdoc" },
  { value: "graduate_student", label: "Grad Student" },
  { value: "research_staff", label: "Research Staff" },
  { value: "data_manager", label: "Data Manager" },
  { value: "project_manager", label: "Project Manager" },
  { value: "nih_program", label: "NIH Program" },
  { value: "admin", label: "Admin (role)" },
  { value: "other", label: "Other" },
];

const WORKING_GROUPS = [
  { token: "WG-Analytics", label: "Analytics" },
  { token: "WG-Devices", label: "Devices" },
  { token: "WG-ELSI", label: "ELSI" },
  { token: "WG-Standards", label: "Standards" },
];

const PI_ROLES = new Set(["contact_pi", "co_pi", "mpi", "co-investigator"]);

type OnboardResult = {
  ok: boolean; investigator_id: string; email: string; role: string; grant_linked: boolean;
  /** Set when the RPC matched an email-less RePORTER import stub for this person instead of
   *  creating a second record: 'adopted_stub' claimed it, 'merged_stub' folded it into the
   *  emailed record. Surfaced so the admin can see WHICH record they just wrote to. */
  reconciled?: "adopted_stub" | "merged_stub" | null;
};

export function OnboardMemberDialog({ trigger }: { trigger: ReactNode }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const [email, setEmail] = useState("");
  const [secondary, setSecondary] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("research_staff");
  const [wgs, setWgs] = useState<Set<string>>(new Set());
  const [tier, setTier] = useState("member");
  const [institution, setInstitution] = useState("");
  const [grantQuery, setGrantQuery] = useState("");
  const [grant, setGrant] = useState<{ id: string; grant_number: string; title: string | null } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OnboardResult | null>(null);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const [smartText, setSmartText] = useState("");
  const [parsing, setParsing] = useState(false);

  const { data: grantResults = [] } = useQuery({
    queryKey: ["grant-search", grantQuery],
    enabled: open && grantQuery.trim().length >= 2 && !grant,
    queryFn: async () => {
      const q = grantQuery.trim().replace(/[%,]/g, " ");
      const { data, error } = await supabase
        .from("grants")
        .select("id,grant_number,title")
        .or(`grant_number.ilike.%${q}%,title.ilike.%${q}%`)
        .limit(8);
      if (error) throw error;
      return (data ?? []) as { id: string; grant_number: string; title: string | null }[];
    },
  });

  const reset = () => {
    setEmail(""); setSecondary(""); setName(""); setRole("research_staff"); setWgs(new Set()); setTier("member");
    setInstitution(""); setGrantQuery(""); setGrant(null);
    setSubmitting(false); setResult(null); setSendingEmail(false); setEmailSent(false);
    setSmartText(""); setParsing(false);
  };

  // Smart-fill: LLM parses free text → pre-fills the fields below (admin reviews, then submits).
  const smartFill = async () => {
    if (!smartText.trim()) return;
    setParsing(true);
    try {
      const { data, error } = await supabase.functions.invoke("parse-onboard", { body: { text: smartText } });
      if (error || !data?.ok) throw new Error(await edgeError(error, data));
      const f = (data as any).fields;
      if (f.email) setEmail(f.email);
      if (f.secondary_email) setSecondary(f.secondary_email);
      if (f.name) setName(f.name);
      if (f.role && ROLES.some((r) => r.value === f.role)) setRole(f.role);
      if (Array.isArray(f.working_groups)) setWgs(new Set(f.working_groups.filter((w: string) => WORKING_GROUPS.some((x) => x.token === w))));
      if (f.institution) setInstitution(f.institution);
      if (f.access_tier && ["member", "curator", "admin"].includes(f.access_tier)) setTier(f.access_tier);
      if (f.grant_hint) { setGrant(null); setGrantQuery(f.grant_hint); }  // seeds the grant search
      toast.success("Fields pre-filled — review and submit");
    } catch (e: any) {
      toast.error(`Smart fill failed: ${e?.message ?? "unknown"}`);
    } finally {
      setParsing(false);
    }
  };

  const onOpenChange = (o: boolean) => { setOpen(o); if (!o) reset(); };

  const toggleWg = (token: string) =>
    setWgs((prev) => { const n = new Set(prev); n.has(token) ? n.delete(token) : n.add(token); return n; });

  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const piNeedsGrant = PI_ROLES.has(role) && !grant;
  const canSubmit = emailValid && name.trim().length > 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc("onboard_member", {
        _email: email.trim(),
        _name: name.trim(),
        _role: role,
        _working_groups: [...wgs],
        _pending_role: tier === "member" ? null : tier,
        _institution: institution.trim() || null,
        _grant_id: grant?.id ?? null,
        _secondary_emails: secondary.trim() ? [secondary.trim().toLowerCase()] : [],
      });
      if (error) throw error;
      const r = data as OnboardResult;
      setResult(r);
      toast.success(
        r.reconciled === "adopted_stub"
          ? `Onboarded ${name.trim()} — matched their existing RePORTER record (no duplicate created)`
          : r.reconciled === "merged_stub"
            ? `Onboarded ${name.trim()} — merged a duplicate RePORTER record into their profile`
            : `Onboarded ${name.trim()}`,
      );
      queryClient.invalidateQueries({ queryKey: ["onboarding-pipeline"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Onboarding failed");
    } finally {
      setSubmitting(false);
    }
  };

  const sendWelcome = async () => {
    if (!result) return;
    setSendingEmail(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-welcome-email", {
        body: { to: result.email, name: name.trim(), role: result.role },
      });
      if (error || (data && (data as any).success === false)) throw new Error(await edgeError(error, data));
      await supabase.rpc("set_onboarding_step", {
        _investigator_id: result.investigator_id, _step: "welcome_email", _status: "done",
      });
      setEmailSent(true);
      toast.success("Welcome email sent");
      queryClient.invalidateQueries({ queryKey: ["onboarding-pipeline"] });
    } catch (e: any) {
      toast.error(`Welcome email failed: ${e?.message ?? "unknown"}`);
    } finally {
      setSendingEmail(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Onboard a member</DialogTitle>
          <DialogDescription>
            Creates the member record and provisions mailing lists / working groups automatically.
            Grant-optional roles onboard grant-free; PI-level roles should be linked to a grant.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          // ── Success view ─────────────────────────────────────────────
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
              <Check className="h-5 w-5" />
              <span className="font-medium">{name.trim()} onboarded{result.grant_linked ? " and linked to the grant" : ""}.</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Consortium / role / working-group access is being provisioned. Remaining steps
              (welcome email, data questionnaire, Slack) show in the pipeline.
            </p>
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  Welcome email
                </div>
                {emailSent ? (
                  <span className="inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
                    <Check className="h-4 w-4" /> Sent
                  </span>
                ) : (
                  <Button size="sm" onClick={sendWelcome} disabled={sendingEmail}>
                    {sendingEmail ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send now"}
                  </Button>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => reset()}>Onboard another</Button>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          // ── Form view ────────────────────────────────────────────────
          <div className="space-y-4 py-2">
            {/* Smart fill — LLM pre-fills the fields for the admin to review */}
            <div className="rounded-md border border-dashed border-border p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Sparkles className="h-4 w-4 text-primary" /> Smart fill <span className="font-normal text-muted-foreground">(optional)</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Paste a form row, an email, or a description — the assistant fills the fields below for you to review.
              </p>
              <Textarea
                rows={3}
                value={smartText}
                onChange={(e) => setSmartText(e.target.value)}
                placeholder="e.g. Sankar Alagapan sankar.alagapan@gatech.edu, co-investigator on Christopher Rozell's R61, analytics + devices + ELSI working groups"
              />
              <Button size="sm" variant="secondary" onClick={smartFill} disabled={parsing || !smartText.trim()}>
                {parsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Sparkles className="mr-1.5 h-4 w-4" />Parse &amp; fill</>}
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <div>
                <Label htmlFor="ob-email">Email <span className="text-destructive">*</span></Label>
                <Input id="ob-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@university.edu" />
              </div>
              <div>
                <Label htmlFor="ob-secondary">Secondary email</Label>
                <Input id="ob-secondary" type="email" value={secondary} onChange={(e) => setSecondary(e.target.value)} placeholder="(optional — for Globus / mailing-list matching)" />
              </div>
              <div>
                <Label htmlFor="ob-name">Full name <span className="text-destructive">*</span></Label>
                <Input id="ob-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Role</Label>
                  <Select value={role} onValueChange={setRole}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Access tier</Label>
                  <Select value={tier} onValueChange={setTier}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member (tier 3)</SelectItem>
                      <SelectItem value="curator">Curator (tier 2)</SelectItem>
                      <SelectItem value="admin">Admin (tier 1)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label>Working groups</Label>
                <div className="flex flex-wrap gap-3 mt-1">
                  {WORKING_GROUPS.map((wg) => (
                    <label key={wg.token} className="flex items-center gap-1.5 text-sm cursor-pointer">
                      <Checkbox checked={wgs.has(wg.token)} onCheckedChange={() => toggleWg(wg.token)} />
                      {wg.label}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <Label htmlFor="ob-inst">Institution</Label>
                <Input id="ob-inst" value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="(optional)" />
              </div>

              <div>
                <Label>Grant {piNeedsGrant && <span className="text-amber-600 dark:text-amber-400 text-xs">(recommended for PI roles)</span>}</Label>
                {grant ? (
                  <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                    <span className="truncate">{grant.title ?? grant.grant_number} <span className="text-muted-foreground">({grant.grant_number})</span></span>
                    <button type="button" onClick={() => { setGrant(null); setGrantQuery(""); }} className="text-muted-foreground hover:text-foreground">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <Input value={grantQuery} onChange={(e) => setGrantQuery(e.target.value)} placeholder="Search grant number or title…" />
                    {grantResults.length > 0 && (
                      <div className="mt-1 rounded-md border border-border divide-y divide-border max-h-40 overflow-y-auto">
                        {grantResults.map((g) => (
                          <button key={g.id} type="button" onClick={() => setGrant(g)} className="block w-full text-left px-3 py-2 text-sm hover:bg-muted">
                            <span className="truncate">{g.title ?? g.grant_number}</span>
                            <span className="text-muted-foreground"> ({g.grant_number})</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={submit} disabled={!canSubmit}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Onboard member"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
