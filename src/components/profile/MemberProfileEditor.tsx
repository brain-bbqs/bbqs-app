import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { edgeError } from "@/lib/edgeError";

const WORKING_GROUPS = [
  { token: "WG-Analytics", label: "Analytics" },
  { token: "WG-Devices", label: "Devices" },
  { token: "WG-ELSI", label: "ELSI" },
  { token: "WG-Standards", label: "Standards" },
];

type InvRow = {
  id: string;
  institution: string | null;
  orcid: string | null;
  research_areas: string[] | null;
  skills: string[] | null;
  secondary_emails: string[] | null;
  working_groups: string[] | null;
  requested_working_groups: string[] | null;
};

const toList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Self-serve profile editor: benign fields write directly to the member's own record;
 *  working groups are submitted as a REQUEST an admin approves (no mailing-list change). */
export function MemberProfileEditor() {
  const { user } = useAuth();
  const [institution, setInstitution] = useState("");
  const [orcid, setOrcid] = useState("");
  const [areas, setAreas] = useState("");
  const [skills, setSkills] = useState("");
  const [secondary, setSecondary] = useState("");
  const [reqWgs, setReqWgs] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const { data: inv, isLoading, refetch } = useQuery({
    queryKey: ["my-investigator", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("investigators")
        .select("id, institution, orcid, research_areas, skills, secondary_emails, working_groups, requested_working_groups")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return (data as InvRow) ?? null;
    },
  });

  useEffect(() => {
    if (!inv) return;
    setInstitution(inv.institution ?? "");
    setOrcid(inv.orcid ?? "");
    setAreas((inv.research_areas ?? []).join(", "));
    setSkills((inv.skills ?? []).join(", "));
    setSecondary((inv.secondary_emails ?? [])[0] ?? "");
    // seed the request from any pending request, else current membership
    setReqWgs(new Set((inv.requested_working_groups ?? inv.working_groups ?? []).filter(Boolean)));
  }, [inv]);

  if (isLoading) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>;
  if (!inv) {
    return (
      <Card><CardContent className="py-6 text-sm text-muted-foreground">
        No consortium profile is linked to your account yet. Once an admin onboards you, you can edit your details here.
      </CardContent></Card>
    );
  }

  const current = (inv.working_groups ?? []).filter(Boolean);
  const pending = (inv.requested_working_groups ?? []).filter(Boolean);
  const toggle = (t: string) => setReqWgs((p) => { const n = new Set(p); n.has(t) ? n.delete(t) : n.add(t); return n; });

  const save = async () => {
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc("member_self_update" as any, {
        _institution: institution.trim() || null,
        _orcid: orcid.trim() || null,
        _research_areas: toList(areas),
        _skills: toList(skills),
        _secondary_emails: secondary.trim() ? [secondary.trim().toLowerCase()] : [],
        _requested_working_groups: [...reqWgs],
      });
      if (error || (data as any)?.ok === false) throw new Error(await edgeError(error, data));
      toast.success("Profile saved" + ([...reqWgs].sort().join() !== current.slice().sort().join() ? " — working-group changes sent for admin approval" : ""));
      refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-lg">Edit my profile</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><Label htmlFor="mp-inst">Institution</Label><Input id="mp-inst" value={institution} onChange={(e) => setInstitution(e.target.value)} /></div>
          <div><Label htmlFor="mp-orcid">ORCID</Label><Input id="mp-orcid" value={orcid} onChange={(e) => setOrcid(e.target.value)} placeholder="0000-0000-0000-0000" /></div>
        </div>
        <div><Label htmlFor="mp-areas">Research areas <span className="text-muted-foreground text-xs">(comma-separated)</span></Label>
          <Input id="mp-areas" value={areas} onChange={(e) => setAreas(e.target.value)} placeholder="Motor control, Neural computation" /></div>
        <div><Label htmlFor="mp-skills">Skills <span className="text-muted-foreground text-xs">(comma-separated)</span></Label>
          <Input id="mp-skills" value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="SpikeInterface, Python" /></div>
        <div><Label htmlFor="mp-sec">Secondary email</Label>
          <Input id="mp-sec" type="email" value={secondary} onChange={(e) => setSecondary(e.target.value)} placeholder="for Globus / mailing-list matching" /></div>

        <div>
          <Label>Working groups</Label>
          <p className="text-xs text-muted-foreground mb-1">
            Your selection is submitted as a <strong>request</strong> — an admin confirms before your mailing-list access changes.
          </p>
          <div className="flex flex-wrap gap-3 mt-1">
            {WORKING_GROUPS.map((wg) => (
              <label key={wg.token} className="flex items-center gap-1.5 text-sm cursor-pointer">
                <Checkbox checked={reqWgs.has(wg.token)} onCheckedChange={() => toggle(wg.token)} />
                {wg.label}
                {current.includes(wg.token) && <span className="text-[10px] text-emerald-600 dark:text-emerald-400">(member)</span>}
              </label>
            ))}
          </div>
          {pending.length > 0 && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Pending approval: {pending.map((w) => w.replace("WG-", "")).join(", ")}</p>}
        </div>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
