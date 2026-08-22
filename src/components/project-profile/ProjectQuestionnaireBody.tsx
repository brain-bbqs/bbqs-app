// The questionnaire itself: every field, its value, and the grade of the source it came from.
//
// Rendered in two places from one definition — the full page at /projects/:grantNumber/profile and
// the "Manage" tab of the project card. The tab used to contain a single button that navigated to
// the page; the data now appears where the tab is, which is what a tab is for.
//
// `variant` only changes layout density and what surrounds the fields. The fields, their editing
// behaviour, the provenance chips and the save path are identical, because they are the same code.
import { RotateCcw, Save, Loader2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QuestionnaireSection } from "./QuestionnaireSection";
import { QUESTIONNAIRE_SECTIONS } from "@/data/questionnaire-fields";
import type { ProjectProfileEditor } from "./useProjectProfileEditor";

export function ProjectQuestionnaireBody({
  editor, canEdit, variant, openSection,
}: {
  editor: ProjectProfileEditor;
  canEdit: boolean;
  variant: "page" | "panel";
  /** Section id to force open (the page passes the URL hash). */
  openSection?: string;
}) {
  const { isLoading, data, getValue, setFieldValue, changedKeys, pendingKeys,
          provenance, hasChanges, commit, isCommitting, discard } = editor;

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (!data?.project) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No questionnaire has been recorded for this project yet.
      </p>
    );
  }

  const panel = variant === "panel";

  return (
    <div className={panel ? "space-y-2" : "space-y-3"}>
      {/* Unsaved-changes bar. Sticky in both variants; in the panel it pins to the top of the
          card's scroll container rather than the window. */}
      {canEdit && hasChanges && (
        <div className="sticky top-0 z-30 bg-card/95 backdrop-blur-sm border border-amber-500/30 rounded-xl px-4 py-3 flex items-center justify-between gap-3 shadow-sm">
          <p className="text-sm text-foreground">
            <span className="font-medium text-amber-600 dark:text-amber-400">{changedKeys.size}</span>{" "}
            field{changedKeys.size !== 1 ? "s" : ""} modified
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="ghost" size="sm" onClick={discard} disabled={isCommitting}>
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Discard
            </Button>
            <Button size="sm" onClick={commit} disabled={isCommitting}>
              {isCommitting
                ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                : <Save className="h-3.5 w-3.5 mr-1.5" />}
              Save changes
            </Button>
          </div>
        </div>
      )}

      {!panel && (
        <div className="flex items-center gap-2 px-1">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Project Questionnaire
          </h2>
        </div>
      )}

      {QUESTIONNAIRE_SECTIONS.map((section, idx) => (
        <QuestionnaireSection
          key={section.id}
          section={section}
          getValue={getValue}
          onSave={setFieldValue}
          changedKeys={changedKeys}
          pendingKeys={pendingKeys}
          provenance={provenance}
          readOnly={!canEdit}
          // The panel is narrow, so only the first section starts open; the page opens two.
          defaultOpen={openSection === section.id || idx < (panel ? 1 : 2)}
        />
      ))}
    </div>
  );
}
