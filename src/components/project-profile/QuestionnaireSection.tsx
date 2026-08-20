import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { QuestionnaireField } from "./QuestionnaireField";
import type { QuestionnaireSection as SectionDef } from "@/data/questionnaire-fields";
import type { ProvenanceLookup } from "@/hooks/useFieldProvenance";

interface Props {
  section: SectionDef;
  getValue: (key: string) => any;
  onSave: (key: string, value: any) => void;
  changedKeys: Set<string>;
  pendingKeys: Set<string>;
  defaultOpen?: boolean;
  readOnly?: boolean;
  provenance?: ProvenanceLookup;
}

export function QuestionnaireSection({
  section, getValue, onSave, changedKeys, pendingKeys, defaultOpen = true, readOnly, provenance,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  const sectionFieldKeys = section.fields.map((f) => f.key);
  const sectionChangedCount = sectionFieldKeys.filter((k) => changedKeys.has(k)).length;
  const sectionPendingCount = sectionFieldKeys.filter((k) => pendingKeys.has(k)).length;

  const filledCount = section.fields.filter((f) => {
    const v = getValue(f.key);
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "string") return v.trim().length > 0;
    if (typeof v === "boolean") return true;
    return v !== null && v !== undefined;
  }).length;

  return (
    <div id={section.id} className="bg-card border border-border rounded-xl overflow-hidden scroll-mt-20">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-5 py-4 hover:bg-muted/30 transition-colors text-left"
        type="button"
      >
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-foreground">{section.title}</h3>
          {section.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{section.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {sectionChangedCount > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 font-medium">
              {sectionChangedCount} modified
            </span>
          )}
          {sectionPendingCount > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-700 dark:text-blue-400 font-medium">
              {sectionPendingCount} suggested
            </span>
          )}
          <span className="text-xs text-muted-foreground tabular-nums">
            {filledCount}/{section.fields.length}
          </span>
        </div>
      </button>

      <div className={cn("overflow-hidden transition-all", open ? "max-h-[5000px]" : "max-h-0")}>
        <div className="px-5 pb-4 space-y-1 border-t border-border/50">
          {section.fields.map((field) => (
            <QuestionnaireField
              key={field.key}
              field={field}
              value={getValue(field.key)}
              isChanged={changedKeys.has(field.key)}
              hasPending={pendingKeys.has(field.key)}
              onSave={onSave}
              readOnly={readOnly}
              provenance={provenance?.get(field.key)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
