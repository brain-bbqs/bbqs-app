/** The visible half of Principle XI: a value that a machine produced must not look like a value a
 *  human verified.
 *
 *  Three visual states, because there are three materially different situations and collapsing them
 *  is what let a wrong species read as curated fact for months:
 *
 *    verified        a person or an authoritative registry stands behind it. Renders QUIETLY -- the
 *                    constitution says a verified value renders plainly, so this is a muted label,
 *                    not a badge competing for attention.
 *    AI-assisted     a named person authored it WITH a model (source class curated_with_ai). Counts
 *                    as verified, because someone is accountable, but is visually distinct because
 *                    the model contributed facts and the species audit proved those can be wrong.
 *                    "Verified" here means attributable, not infallible.
 *    unverified      tier 5/6 -- machine-extracted, web-retrieved, or no recorded source at all.
 *                    This is the state that must be impossible to miss.
 *
 *  The popover carries the full PROV record for staff: agent, activity, model, when the VALUE was
 *  authored (with its precision, so "on or about" stays "on or about"), the source reference, and
 *  any verbatim evidence. That is what makes a disputed value checkable instead of arguable.
 */
import { BadgeCheck, Sparkles, HelpCircle, Bot } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { FieldProvenance } from "@/hooks/useFieldProvenance";

const AI_ASSISTED = "curated_with_ai";

type Tone = "verified" | "ai" | "unverified";

const toneOf = (p: FieldProvenance): Tone =>
  p.source_class === AI_ASSISTED ? "ai" : p.is_verified ? "verified" : "unverified";

const TONE: Record<Tone, { cls: string; Icon: typeof BadgeCheck; label?: string }> = {
  verified: {
    cls: "text-muted-foreground/70 hover:text-muted-foreground",
    Icon: BadgeCheck,
  },
  ai: {
    cls: "text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300",
    Icon: Sparkles,
  },
  unverified: {
    cls: "text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300",
    Icon: HelpCircle,
  },
};

/** "2026-03-06 (approximate)" rather than a false-precision timestamp. */
const authoredLabel = (p: FieldProvenance): string | null => {
  if (!p.authored_at) return null;
  const day = p.authored_at.slice(0, 10);
  const prec = p.authored_at_precision;
  if (!prec || prec === "exact") return day;
  if (prec === "month") return `${day.slice(0, 7)} (month only)`;
  return `${day} (${prec})`;
};

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[5.5rem_1fr] gap-2 text-xs">
    <span className="text-muted-foreground">{label}</span>
    <span className="break-words">{children}</span>
  </div>
);

export function ProvenanceChip({
  provenance,
  className,
}: {
  provenance?: FieldProvenance;
  className?: string;
}) {
  // No claim recorded. Deliberately renders nothing rather than a warning: an environment without
  // the migration applied, or a viewer without permission, must not paint every field as suspect.
  if (!provenance) return null;

  const tone = toneOf(provenance);
  const { cls, Icon } = TONE[tone];
  const authored = authoredLabel(provenance);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn("flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide transition-colors", cls, className)}
          aria-label={`Source: ${provenance.source_label}. Click for full provenance.`}
        >
          <Icon className="h-3 w-3" />
          <span>{tone === "unverified" ? "Unverified" : provenance.source_label}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 space-y-2.5">
        <div className="flex items-start gap-2">
          <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", cls)} />
          <div>
            <p className="text-sm font-semibold leading-tight">{provenance.source_label}</p>
            <p className="text-xs text-muted-foreground">
              Tier {provenance.source_rank} ·{" "}
              {tone === "unverified"
                ? "not human-verified"
                : tone === "ai"
                  ? "human-accountable, AI-assisted"
                  : "human-verified"}
            </p>
          </div>
        </div>

        {tone === "unverified" && (
          <p className="text-xs text-amber-700 dark:text-amber-400 leading-snug">
            No person or registry has vouched for this value. Treat it as a starting point, not a fact.
          </p>
        )}
        {tone === "ai" && (
          <p className="text-xs text-violet-700 dark:text-violet-400 leading-snug">
            Written by a named person working with a model. Attributable, but factual details are
            worth checking against the grant record.
          </p>
        )}

        <div className="space-y-1 pt-1 border-t border-border">
          {provenance.agent_label && <Row label="Author">{provenance.agent_label}</Row>}
          <Row label="How">{provenance.activity.replace(/_/g, " ")}</Row>
          {provenance.model_id && (
            <Row label="Model">
              <span className="inline-flex items-center gap-1">
                <Bot className="h-3 w-3" />
                {provenance.model_id}
              </span>
            </Row>
          )}
          {authored && <Row label="Authored">{authored}</Row>}
          {provenance.source_ref && <Row label="Source">{provenance.source_ref}</Row>}
          {provenance.confidence != null && (
            <Row label="Confidence">{Math.round(provenance.confidence * 100)}%</Row>
          )}
          <Row label="Recorded">{provenance.recorded_at.slice(0, 10)}</Row>
          {provenance.claim_count > 1 && (
            // A cell whose source has been restated or revised deserves a second look even when the
            // newest claim looks fine.
            <Row label="Claims">
              {provenance.claim_count} (this is the current one)
            </Row>
          )}
        </div>

        {provenance.evidence && (
          <div className="pt-1 border-t border-border">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Evidence</p>
            <p className="text-xs italic leading-snug text-muted-foreground">
              “{provenance.evidence}”
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
