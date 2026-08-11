import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type CurationEntityType =
  | "project_metadata"
  | "team_roster"
  | "pending_change_decision"
  | "investigator"
  | "entity_comment";

export type CurationAction = "create" | "update" | "delete";

export interface AuditWriteInput {
  entity_type: CurationEntityType;
  action: CurationAction;
  entity_id?: string | null;
  grant_number?: string | null;
  resource_id?: string | null;
  project_id?: string | null;
  investigator_id?: string | null;
  field_name?: string | null;
  before_value?: any;
  after_value?: any;
  source?: string;
}

/**
 * Insert an audit row for a curation write. Returns the new audit id (or null on failure).
 * Designed to be fire-and-forget — never blocks the caller's success path.
 */
export async function recordCurationAudit(input: AuditWriteInput): Promise<string | null> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data, error } = await (supabase.from("curation_audit_log" as any) as any)
      .insert({
        ...input,
        actor_id: user.id,
        source: input.source ?? "manual",
      })
      .select("id")
      .single();
    if (error) {
      console.warn("[audit] insert failed", error.message);
      return null;
    }
    return data?.id ?? null;
  } catch (e) {
    console.warn("[audit] insert exception", e);
    return null;
  }
}

/**
 * Call the universal revert RPC.
 */
export async function revertCurationChange(auditId: string): Promise<boolean> {
  const { error } = await supabase.rpc("revert_curation_change", {
    _audit_id: auditId,
  });
  if (error) {
    toast.error("Could not undo", { description: error.message });
    return false;
  }
  return true;
}

/**
 * Show a toast with an Undo action that reverts the given audit row.
 * If `auditId` is null (e.g. audit insert failed), shows a plain success toast.
 */
export function showUndoableToast(opts: {
  title: string;
  description?: string;
  auditId: string | null;
  onReverted?: () => void;
}) {
  const { title, description, auditId, onReverted } = opts;
  if (!auditId) {
    toast.success(title, { description });
    return;
  }
  toast.success(title, {
    description,
    duration: 10_000,
    action: {
      label: "Undo",
      onClick: async () => {
        const ok = await revertCurationChange(auditId);
        if (ok) {
          toast.success("Change reverted");
          onReverted?.();
        }
      },
    },
  });
}
