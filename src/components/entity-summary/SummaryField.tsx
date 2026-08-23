import { ReactNode } from "react";
import { ProvenanceChip } from "@/components/provenance/ProvenanceChip";
import { useProvenanceScope } from "@/components/provenance/ProvenanceScope";

interface SummaryFieldProps {
  label: string;
  children: ReactNode;
  className?: string;
  /** KG column this field displays, e.g. "institution" or "taxonomy_family". Given this, the field
   *  shows where its value came from and how far that source can be trusted.
   *
   *  Omit it for fields that are not a single stored cell — a computed count, a joined list, a
   *  rendered link — because there is no one claim to grade and a chip would imply otherwise.
   *  Metadata JSON keys work too: the lookup tries the plain name, then `metadata.<name>`. */
  field?: string;
}

export function SummaryField({ label, children, className = "", field }: SummaryFieldProps) {
  // Empty outside a ProvenanceScope, so an unwired summary renders exactly as before.
  const provenance = useProvenanceScope();
  const claim = field ? provenance.get(field) : undefined;

  return (
    <div className={`grid grid-cols-[140px_1fr] gap-3 py-2.5 border-b border-border/50 last:border-0 ${className}`}>
      <span className="text-sm font-medium text-muted-foreground flex items-start gap-1.5">
        <span className="flex-1">{label}</span>
        {/* Against the label, not the value: values wrap, and a chip that moves with the last line
            of a long value is hard to find and harder to click.
            Icon only: the label column is a fixed 140px, and the chip's text form measured 156px,
            overflowing every row it appeared on. */}
        <ProvenanceChip provenance={claim} compact className="mt-px shrink-0" />
      </span>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}
