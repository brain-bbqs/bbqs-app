import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { alreadyInKgMessage } from "@/lib/alreadyInKg";

interface Props {
  trigger: React.ReactNode;
  onCreated?: () => void;
}

export function AddFundingOpportunityDialog({ trigger, onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [fon, setFon] = useState("");
  const [title, setTitle] = useState("");
  const [activityCode, setActivityCode] = useState("");
  const [status, setStatus] = useState<"open" | "upcoming" | "closed">("open");
  const [url, setUrl] = useState("");
  const [purpose, setPurpose] = useState("");
  const [postedDate, setPostedDate] = useState("");
  const [openDate, setOpenDate] = useState("");
  const [expirationDate, setExpirationDate] = useState("");
  const [budgetCeiling, setBudgetCeiling] = useState("");
  const [participatingOrgs, setParticipatingOrgs] = useState("");
  const [relevanceTags, setRelevanceTags] = useState("");
  const [notes, setNotes] = useState("");

  const reset = () => {
    setFon(""); setTitle(""); setActivityCode(""); setStatus("open");
    setUrl(""); setPurpose(""); setPostedDate(""); setOpenDate("");
    setExpirationDate(""); setBudgetCeiling(""); setParticipatingOrgs("");
    setRelevanceTags(""); setNotes("");
  };

  const splitList = (s: string) =>
    s.split(",").map((x) => x.trim()).filter(Boolean);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fon.trim() || !title.trim()) {
      toast({ title: "FON and title are required", variant: "destructive" });
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("funding_opportunities").insert({
      fon: fon.trim(),
      title: title.trim(),
      activity_code: activityCode.trim() || null,
      status,
      url: url.trim() || null,
      purpose: purpose.trim() || null,
      posted_date: postedDate || null,
      open_date: openDate || null,
      expiration_date: expirationDate || null,
      budget_ceiling: budgetCeiling ? Number(budgetCeiling) : null,
      participating_orgs: splitList(participatingOrgs),
      relevance_tags: splitList(relevanceTags),
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (error) {
      // A FON already in the KG (uq_funding_opportunities_fon_key, 20261117181500, or the exact
      // funding_opportunities_fon_key) is said as such; any other error as it came.
      const dup = alreadyInKgMessage(error, { fon, url });
      toast({ title: dup ? "Already in the KG" : "Failed to add opportunity", description: dup ?? error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Funding opportunity added" });
    reset();
    setOpen(false);
    onCreated?.();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Funding Opportunity</DialogTitle>
          <DialogDescription>
            Manually add an NIH or other funding opportunity to the directory.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fon">FON / Number *</Label>
              <Input id="fon" value={fon} onChange={(e) => setFon(e.target.value)} placeholder="RFA-DA-26-001" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="activity">Activity Code</Label>
              <Input id="activity" value={activityCode} onChange={(e) => setActivityCode(e.target.value)} placeholder="R01" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="title">Title *</Label>
            <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="url">URL</Label>
            <Input id="url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://grants.nih.gov/..." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="upcoming">Upcoming</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="budget">Budget Ceiling ($)</Label>
              <Input id="budget" type="number" value={budgetCeiling} onChange={(e) => setBudgetCeiling(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="posted">Posted</Label>
              <Input id="posted" type="date" value={postedDate} onChange={(e) => setPostedDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="open">Opens</Label>
              <Input id="open" type="date" value={openDate} onChange={(e) => setOpenDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="expires">Expires</Label>
              <Input id="expires" type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="orgs">Participating Institutes (comma-separated)</Label>
            <Input id="orgs" value={participatingOrgs} onChange={(e) => setParticipatingOrgs(e.target.value)} placeholder="NIMH, NINDS, NIDA" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tags">Relevance Tags (comma-separated)</Label>
            <Input id="tags" value={relevanceTags} onChange={(e) => setRelevanceTags(e.target.value)} placeholder="behavior, neural recording" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="purpose">Purpose</Label>
            <Textarea id="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={3} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Add Opportunity"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}