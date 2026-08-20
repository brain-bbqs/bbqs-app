import { useState, useRef, useCallback } from "react";
import { Pencil, X, Check, Plus, HelpCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ProvenanceChip } from "@/components/provenance/ProvenanceChip";
import type { FieldProvenance } from "@/hooks/useFieldProvenance";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { QuestionnaireField as FieldDef } from "@/data/questionnaire-fields";

interface Props {
  field: FieldDef;
  value: any;
  isChanged: boolean;
  hasPending: boolean;
  /** Where this value came from. Undefined renders nothing (see ProvenanceChip). */
  provenance?: FieldProvenance;
  onSave: (key: string, value: any) => void;
  readOnly?: boolean;
}

/**
 * Renders one questionnaire field with inline edit affordances.
 * Supports text, textarea, tags, boolean, link, number, select.
 */
export function QuestionnaireField({ field, value, isChanged, hasPending, onSave, readOnly, provenance }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<any>(value);
  const [tagInput, setTagInput] = useState("");
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null);

  const isEmpty =
    value === null || value === undefined || value === "" ||
    (Array.isArray(value) && value.length === 0);

  const startEdit = useCallback(() => {
    setDraft(value);
    setTagInput("");
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [value]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setDraft(value);
  }, [value]);

  const saveEdit = useCallback(() => {
    let v = draft;
    if (field.type === "number" && v !== "" && v !== null) {
      v = Number(v);
      if (Number.isNaN(v)) v = null;
    }
    onSave(field.key, v);
    setEditing(false);
  }, [draft, field.key, field.type, onSave]);

  const addTag = useCallback(
    (tag?: string) => {
      const t = (tag ?? tagInput).trim();
      if (!t) return;
      const current = Array.isArray(draft) ? draft : [];
      if (current.includes(t)) {
        setTagInput("");
        return;
      }
      const next = [...current, t];
      setDraft(next);
      onSave(field.key, next);
      setTagInput("");
    },
    [tagInput, draft, onSave, field.key]
  );

  const removeTag = useCallback(
    (tag: string) => {
      const next = (Array.isArray(value) ? value : []).filter((t: string) => t !== tag);
      onSave(field.key, next);
    },
    [value, onSave, field.key]
  );

  const toggleBoolean = useCallback(() => {
    if (readOnly) return;
    onSave(field.key, !value);
  }, [value, onSave, field.key, readOnly]);

  return (
    <div
      className={cn(
        "space-y-1.5 p-3 -mx-3 rounded-lg transition-colors",
        isChanged && "bg-amber-500/10 border border-amber-500/30",
        hasPending && !isChanged && "bg-blue-500/5 border border-blue-500/20"
      )}
    >
      <div className="flex items-center gap-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex-1">
          {field.label}
        </p>
        {field.help && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="text-muted-foreground/60 hover:text-muted-foreground" type="button">
                <HelpCircle className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              <p className="text-xs">{field.help}</p>
            </TooltipContent>
          </Tooltip>
        )}
        <ProvenanceChip provenance={provenance} />
        {isChanged && (
          <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400 uppercase">
            Modified
          </span>
        )}
        {hasPending && !isChanged && (
          <span className="text-[10px] font-medium text-blue-600 dark:text-blue-400 uppercase">
            AI suggestion
          </span>
        )}
        {!readOnly && field.type === "boolean" && (
          <button
            onClick={toggleBoolean}
            className="p-1 rounded hover:bg-muted transition-colors"
            title="Toggle"
            type="button"
          >
            <Pencil className="h-3 w-3 text-muted-foreground" />
          </button>
        )}
        {!readOnly && !editing && field.type !== "boolean" && field.type !== "tags" && (
          <button
            onClick={startEdit}
            className="p-1 rounded hover:bg-muted transition-colors"
            title="Edit"
            type="button"
          >
            <Pencil className="h-3 w-3 text-muted-foreground" />
          </button>
        )}
        {!readOnly && field.type === "tags" && !editing && (
          <button
            onClick={startEdit}
            className="p-1 rounded hover:bg-muted transition-colors"
            title="Add"
            type="button"
          >
            <Plus className="h-3 w-3 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Boolean */}
      {field.type === "boolean" && (
        <p className="text-sm text-foreground">{value ? "Yes" : "No"}</p>
      )}

      {/* Tags */}
      {field.type === "tags" && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {Array.isArray(value) && value.length > 0 ? (
              value.map((tag: string, i: number) => (
                <Badge key={i} variant="secondary" className="text-xs font-normal gap-1 pr-1">
                  {tag}
                  {!readOnly && (
                    <button
                      onClick={() => removeTag(tag)}
                      className="hover:text-destructive transition-colors"
                      type="button"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </Badge>
              ))
            ) : (
              !editing && <p className="text-sm text-muted-foreground/50 italic">Not set</p>
            )}
          </div>
          {editing && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <input
                  ref={inputRef as React.RefObject<HTMLInputElement>}
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag();
                    }
                    if (e.key === "Escape") cancelEdit();
                  }}
                  placeholder="Type and press Enter…"
                  className="flex-1 text-sm bg-muted/50 border border-border rounded-md px-2.5 py-1.5 outline-none focus:border-primary/50"
                />
                <button
                  onClick={() => addTag()}
                  className="p-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
                  type="button"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={cancelEdit}
                  className="p-1.5 rounded-md hover:bg-muted"
                  type="button"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </div>
              {field.suggestions && field.suggestions.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {field.suggestions
                    .filter((s) => !(Array.isArray(value) ? value : []).includes(s))
                    .slice(0, 12)
                    .map((s) => (
                      <button
                        key={s}
                        onClick={() => addTag(s)}
                        className="text-[11px] px-2 py-0.5 rounded-full border border-border bg-background hover:bg-accent transition-colors"
                        type="button"
                      >
                        + {s}
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Select */}
      {field.type === "select" && (
        editing ? (
          <div className="space-y-1.5">
            <select
              ref={inputRef as React.RefObject<HTMLSelectElement>}
              value={draft ?? ""}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full text-sm bg-muted/50 border border-border rounded-md px-2.5 py-1.5 outline-none focus:border-primary/50"
            >
              <option value="">— Select —</option>
              {field.options?.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
            <div className="flex gap-1">
              <button onClick={saveEdit} className="p-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90" type="button">
                <Check className="h-3.5 w-3.5" />
              </button>
              <button onClick={cancelEdit} className="p-1 rounded-md hover:bg-muted" type="button">
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>
          </div>
        ) : (
          isEmpty
            ? <p className="text-sm text-muted-foreground/50 italic">Not set</p>
            : <p className="text-sm text-foreground">{String(value)}</p>
        )
      )}

      {/* Text / Textarea / Link / Number */}
      {(field.type === "text" || field.type === "textarea" || field.type === "link" || field.type === "number") && (
        editing ? (
          <div className="space-y-1.5">
            {field.type === "textarea" ? (
              <textarea
                ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                value={draft ?? ""}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") cancelEdit(); }}
                rows={4}
                className="w-full text-sm bg-muted/50 border border-border rounded-md px-2.5 py-1.5 outline-none focus:border-primary/50 resize-y"
              />
            ) : (
              <input
                ref={inputRef as React.RefObject<HTMLInputElement>}
                type={field.type === "number" ? "number" : "text"}
                value={draft ?? ""}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }}
                className="w-full text-sm bg-muted/50 border border-border rounded-md px-2.5 py-1.5 outline-none focus:border-primary/50"
              />
            )}
            <div className="flex gap-1">
              <button onClick={saveEdit} className="p-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90" type="button">
                <Check className="h-3.5 w-3.5" />
              </button>
              <button onClick={cancelEdit} className="p-1 rounded-md hover:bg-muted" type="button">
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>
          </div>
        ) : isEmpty ? (
          <p className="text-sm text-muted-foreground/50 italic">Not set</p>
        ) : field.type === "link" ? (
          <a href={String(value)} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline break-all">
            {String(value)}
          </a>
        ) : (
          <p className="text-sm text-foreground whitespace-pre-wrap">{String(value)}</p>
        )
      )}
    </div>
  );
}
