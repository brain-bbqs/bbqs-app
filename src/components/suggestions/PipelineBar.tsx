const STAGES = ["submitted", "triage", "in-qa", "approved", "merged"] as const;

const LABELS: Record<string, string> = {
  submitted: "Submitted",
  triage: "Triage",
  "in-qa": "In QA",
  approved: "Approved",
  merged: "Merged",
  declined: "Declined",
};

interface Props {
  stage: string | null | undefined;
  version?: string | null;
}

export function PipelineBar({ stage, version }: Props) {
  const current = (stage || "submitted").toLowerCase();
  const declined = current === "declined";
  const index = STAGES.indexOf(current as (typeof STAGES)[number]);
  const activeIndex = index === -1 ? 0 : index;

  return (
    <div className="flex flex-col gap-1 py-1 w-full">
      <div className="flex items-center gap-1" title={LABELS[current] || current}>
        {STAGES.map((s, i) => {
          const done = !declined && i <= activeIndex;
          return (
            <span
              key={s}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                declined
                  ? "bg-destructive/30"
                  : done
                    ? i === activeIndex
                      ? "bg-primary"
                      : "bg-primary/60"
                    : "bg-muted"
              }`}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[11px] font-medium ${declined ? "text-destructive" : "text-foreground"}`}>
          {LABELS[current] || current}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {declined ? "closed" : version ? version : `${activeIndex + 1}/${STAGES.length}`}
        </span>
      </div>
    </div>
  );
}
