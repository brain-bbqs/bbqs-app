import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, CheckCircle2, ArrowLeft } from "lucide-react";
import { PageMeta } from "@/components/PageMeta";

// Fixed role vocabulary — maps cleanly onto the agent's role normalization
// (contact_pi / co_pi / postdoc / graduate_student / research_staff / NIH program
// staff). "Other" reveals a free-text box. Stored verbatim in
// access_requests.requested_role so onboarding starts with a known role.
const ROLE_OPTIONS = [
  "Contact PI",
  "Co-PI / MPI",
  "Postdoc",
  "Graduate student",
  "Research staff",
  "NIH program staff",
  "Other",
] as const;

const requestSchema = z
  .object({
    full_name: z
      .string()
      .trim()
      .min(2, "Please enter your full name")
      .max(120, "Name must be under 120 characters"),
    email: z
      .string()
      .trim()
      .email("Please enter a valid email address")
      .max(255, "Email must be under 255 characters"),
    institution: z
      .string()
      .trim()
      .min(2, "Please enter your institution")
      .max(200, "Institution must be under 200 characters"),
    requested_role: z.string().min(1, "Please select your role in BBQS"),
    other_role: z.string().trim().max(120).optional().or(z.literal("")),
    // Which BBQS grant / PI they belong to. REQUIRED (or an explicit "not affiliated"
    // declaration) — a reviewer can't route or justify access without it, and
    // institution is not a proxy since several BBQS grants share one.
    association: z
      .string()
      .trim()
      .max(200, "Keep this under 200 characters")
      .optional()
      .or(z.literal("")),
    no_association: z.boolean().optional(),
    message: z
      .string()
      .trim()
      .max(1500, "Message must be under 1500 characters")
      .optional()
      .or(z.literal("")),
  })
  .refine(
    (d) => d.requested_role !== "Other" || (d.other_role && d.other_role.length >= 2),
    { message: "Please describe your role", path: ["other_role"] },
  )
  .refine(
    (d) => d.no_association === true || ((d.association ?? "").trim().length >= 2),
    {
      message: "Tell us which BBQS grant or PI you're associated with",
      path: ["association"],
    },
  );

/** What we persist when the requester declares no grant/PI tie — a definite value
 *  beats a blank field, so the reviewer knows they were asked and answered. */
const NO_ASSOCIATION = "Not affiliated with a specific BBQS grant or PI (self-declared)";

export default function RequestAccess() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Prefilled from the Globus sign-in redirect (a non-member who tried to sign in
  // is routed here with their identity attached). Email is locked when it comes
  // from Globus — it MUST match the identity they'll sign in with.
  const globusEmail = searchParams.get("email") ?? "";
  const globusName = searchParams.get("name") ?? "";
  const globusSubject = searchParams.get("subject") ?? "";
  const emailLocked = globusEmail.length > 0;

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({
    full_name: globusName,
    email: globusEmail,
    institution: "",
    requested_role: "",
    other_role: "",
    association: "",
    no_association: false,
    message: "",
  });

  const update =
    (field: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = requestSchema.safeParse(form);
    if (!parsed.success) {
      const first = parsed.error.errors[0];
      toast.error(first?.message ?? "Please review the form.");
      return;
    }

    const roleValue =
      parsed.data.requested_role === "Other"
        ? (parsed.data.other_role || "Other").trim()
        : parsed.data.requested_role;

    const associationValue = parsed.data.no_association
      ? NO_ASSOCIATION
      : (parsed.data.association || "").trim();

    setSubmitting(true);
    try {
      // Route through the shared SECURITY DEFINER upsert so these details ENRICH the
      // pending row the failed Globus sign-in may have already auto-filed for this
      // email (rather than colliding on the one-pending-per-email unique index and
      // losing the institution/role captured here). Falls back to a direct insert if
      // the RPC migration hasn't been applied yet (PGRST202).
      const { error } = await supabase.rpc("upsert_access_request", {
        _email: parsed.data.email.toLowerCase(),
        _full_name: parsed.data.full_name,
        _institution: parsed.data.institution,
        _requested_role: roleValue,
        _message: parsed.data.message || null,
        _globus_name: globusName || parsed.data.full_name,
        _globus_subject: globusSubject || null,
        _association: associationValue || null,
      });
      if (error) {
        if ((error as { code?: string }).code === "PGRST202") {
          // RPC not deployed yet — fall back to a direct insert. A partial unique
          // index on (lower(email)) WHERE status='pending' guards against a second
          // pending request; treat that conflict as "already submitted".
          const { error: insErr } = await supabase.from("access_requests").insert({
            full_name: parsed.data.full_name,
            email: parsed.data.email.toLowerCase(),
            institution: parsed.data.institution,
            requested_role: roleValue,
            association: associationValue || null,
            message: parsed.data.message || null,
            globus_name: globusName || parsed.data.full_name,
            globus_subject: globusSubject || null,
            status: "pending",
          });
          if (insErr && (insErr as { code?: string }).code !== "23505") throw insErr;
          setSubmitted(true);
          return;
        }
        throw error;
      }
      setSubmitted(true);
    } catch (err: any) {
      console.error(err);
      toast.error(
        err?.message?.includes("row-level")
          ? "Submission blocked. Please double-check your details and try again."
          : err?.message ?? "Failed to submit request.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <PageMeta
          title="Request submitted — BBQS"
          description="Your access request has been received."
        />
        <Card className="w-full max-w-md">
          <CardContent className="p-10 flex flex-col items-center text-center gap-4">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
              <CheckCircle2 className="h-7 w-7 text-primary" />
            </div>
            <h1 className="text-2xl font-bold">Request submitted</h1>
            <p className="text-sm text-muted-foreground">
              Thanks! A consortium administrator will review your request shortly. You'll be
              notified by email once approved, after which you can sign in via Globus.
            </p>
            <Button asChild variant="outline" className="mt-2">
              <Link to="/auth">
                <ArrowLeft className="h-4 w-4 mr-2" /> Back to sign-in
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-10">
      <PageMeta
        title="Request access — BBQS"
        description="Request a BBQS consortium account."
      />
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="text-2xl">Request an account</CardTitle>
          <CardDescription>
            BBQS is a consortium-restricted platform. Submit a quick request and an
            administrator will review it. Once approved, you'll sign in with your institutional
            Globus account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="full_name">Full name</Label>
              <Input
                id="full_name"
                value={form.full_name}
                onChange={update("full_name")}
                placeholder="Jane Doe"
                maxLength={120}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Institutional email</Label>
              <Input
                id="email"
                type="email"
                value={form.email}
                onChange={update("email")}
                placeholder="jane@university.edu"
                maxLength={255}
                required
                readOnly={emailLocked}
                className={emailLocked ? "bg-muted cursor-not-allowed" : undefined}
              />
              <p className="text-xs text-muted-foreground">
                {emailLocked
                  ? "From your Globus identity — this is the email you'll sign in with."
                  : "Use the email tied to your Globus identity."}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="institution">Institution</Label>
              <Input
                id="institution"
                value={form.institution}
                onChange={update("institution")}
                placeholder="University of Example"
                maxLength={200}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="requested_role">Your role in BBQS</Label>
              <Select
                value={form.requested_role}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, requested_role: v, other_role: v === "Other" ? f.other_role : "" }))
                }
              >
                <SelectTrigger id="requested_role">
                  <SelectValue placeholder="Select your role…" />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.requested_role === "Other" && (
                <Input
                  aria-label="Describe your role"
                  value={form.other_role}
                  onChange={update("other_role")}
                  placeholder="e.g. Program coordinator"
                  maxLength={120}
                  className="mt-2"
                />
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="association">
                Which BBQS grant or PI are you associated with?
              </Label>
              <Input
                id="association"
                value={form.association}
                onChange={update("association")}
                placeholder="e.g. U24MH136628 — or your PI's name, e.g. Satra Ghosh"
                maxLength={200}
                disabled={form.no_association}
                required={!form.no_association}
              />
              <p className="text-xs text-muted-foreground">
                A grant number or the PI whose lab/group you work in. This is how we
                route you to the right project and working groups.
              </p>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={form.no_association}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, no_association: e.target.checked }))
                  }
                  className="h-3.5 w-3.5 rounded border-border"
                />
                I'm not affiliated with a specific BBQS grant or PI
              </label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="message">Why are you requesting access? (optional)</Label>
              <Textarea
                id="message"
                value={form.message}
                onChange={update("message")}
                placeholder="Briefly describe how you'd use the platform."
                rows={4}
                maxLength={1500}
              />
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <Button asChild variant="ghost" type="button">
                <Link to="/auth">
                  <ArrowLeft className="h-4 w-4 mr-2" /> Sign in instead
                </Link>
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Submit request
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
