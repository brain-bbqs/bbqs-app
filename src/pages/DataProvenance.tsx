"use client";

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { History, Search, Loader2, User, Bot, MessageSquare, Shield, CheckCircle2, AlertTriangle, XCircle, LogIn, Undo2 } from "lucide-react";
import { useState, useMemo, useCallback, useRef } from "react";
import { format } from "date-fns";
import { useAuth } from "@/contexts/AuthContext";
import { Link } from "react-router-dom";
import { revertCurationChange } from "@/lib/curation-audit";
import { useQueryClient } from "@tanstack/react-query";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import "@/styles/ag-grid-theme.css";
import { ProvenanceGrades } from "@/components/provenance/ProvenanceGrades";
import { useHashState } from "@/hooks/useHashState";
import { cn } from "@/lib/utils";

interface EditRow {
  id: string;
  created_at: string;
  grant_number: string;
  field_name: string;
  edited_by: string;
  old_value: any;
  new_value: any;
  chat_context: any;
  project_title?: string;
  validation_status?: string | null;
  validation_checks?: any | null;
  audit_id?: string | null;
  audit_reverted?: boolean;
}

interface ChatMessage {
  role: string;
  content: string;
}

const TimestampCell = ({ value }: ICellRendererParams) => {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="text-xs font-mono text-muted-foreground">
      {format(new Date(value), "MMM d, yyyy HH:mm")}
    </span>
  );
};

const ProjectCell = ({ value, data }: ICellRendererParams) => {
  return (
    <div className="text-xs leading-tight py-1">
      <span className="font-medium text-foreground truncate block max-w-[200px]">
        {data.project_title || data.grant_number}
      </span>
      {data.project_title && (
        <span className="text-muted-foreground text-[10px]">{data.grant_number}</span>
      )}
    </div>
  );
};

const FieldCell = ({ value }: ICellRendererParams) => {
  const fieldColors: Record<string, string> = {
    study_species: "bg-emerald-100 text-emerald-800 border-emerald-200",
    use_approaches: "bg-blue-100 text-blue-800 border-blue-200",
    use_sensors: "bg-violet-100 text-violet-800 border-violet-200",
    produce_data_modality: "bg-amber-100 text-amber-800 border-amber-200",
    produce_data_type: "bg-orange-100 text-orange-800 border-orange-200",
    use_analysis_types: "bg-cyan-100 text-cyan-800 border-cyan-200",
    use_analysis_method: "bg-teal-100 text-teal-800 border-teal-200",
    keywords: "bg-pink-100 text-pink-800 border-pink-200",
    develope_software_type: "bg-indigo-100 text-indigo-800 border-indigo-200",
    develope_hardware_type: "bg-rose-100 text-rose-800 border-rose-200",
  };
  const color = fieldColors[value] || "bg-secondary text-secondary-foreground border-border";
  return (
    <Badge variant="outline" className={`text-[10px] font-mono ${color}`}>
      {value}
    </Badge>
  );
};

const EditorCell = ({ value }: ICellRendererParams) => {
  const isAI = value === "ai-assistant";
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {isAI ? (
        <Bot className="h-3.5 w-3.5 text-primary" />
      ) : (
        <User className="h-3.5 w-3.5 text-muted-foreground" />
      )}
      <span className={isAI ? "text-primary font-medium" : "text-muted-foreground"}>{value}</span>
    </div>
  );
};

const ValueCell = ({ value, data, colDef }: ICellRendererParams) => {
  const isOld = colDef?.field === "old_value";
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/40 text-xs italic">—</span>;
  }
  const items = Array.isArray(value) ? value : [value];
  return (
    <div className="flex flex-wrap gap-1 py-1 max-w-[180px]">
      {items.slice(0, 4).map((v: any, i: number) => (
        <Badge
          key={i}
          variant={isOld ? "secondary" : "default"}
          className={`text-[10px] ${isOld ? "line-through opacity-60" : ""}`}
        >
          {typeof v === "object" ? JSON.stringify(v) : String(v)}
        </Badge>
      ))}
      {items.length > 4 && (
        <Badge variant="outline" className="text-[10px] text-muted-foreground">+{items.length - 4}</Badge>
      )}
    </div>
  );
};

const ValidationCell = ({ data }: ICellRendererParams) => {
  const status = data.validation_status;
  const protocols: string[] = [];
  const checks: any[] = data.validation_checks || [];

  if (!status) {
    return <span className="text-muted-foreground/40 text-xs italic">—</span>;
  }

  const config = {
    approved: { icon: CheckCircle2, label: "Approved", className: "text-emerald-600 dark:text-emerald-400" },
    needs_review: { icon: AlertTriangle, label: "Review", className: "text-amber-600 dark:text-amber-400" },
    rejected: { icon: XCircle, label: "Rejected", className: "text-red-600 dark:text-red-400" },
  }[status] || { icon: Shield, label: status, className: "text-muted-foreground" };

  const Icon = config.icon;
  const passCount = checks.filter((c: any) => c.status === "pass").length;
  const warnCount = checks.filter((c: any) => c.status === "warning").length;
  const failCount = checks.filter((c: any) => c.status === "fail").length;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5 cursor-default">
            <Icon className={`h-3.5 w-3.5 ${config.className}`} />
            <span className={`text-xs font-medium ${config.className}`}>{config.label}</span>
            {protocols.length > 0 && (
              <Badge variant="outline" className="text-[9px] px-1 py-0 text-muted-foreground">
                {protocols.length}
              </Badge>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs p-3">
          <div className="space-y-2">
            <p className="text-xs font-semibold flex items-center gap-1.5">
              <Shield className="h-3 w-3" /> Validation Protocols
            </p>
            <div className="flex flex-wrap gap-1">
              {protocols.map((p, i) => (
                <Badge key={i} variant="outline" className="text-[10px]">{p}</Badge>
              ))}
            </div>
            <div className="flex gap-3 text-[11px] text-muted-foreground">
              {passCount > 0 && <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-500" />{passCount}</span>}
              {warnCount > 0 && <span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-amber-500" />{warnCount}</span>}
              {failCount > 0 && <span className="flex items-center gap-1"><XCircle className="h-3 w-3 text-red-500" />{failCount}</span>}
            </div>
            {checks.length > 0 && (
              <div className="border-t border-border pt-1.5 space-y-1 max-h-32 overflow-y-auto">
                {checks.slice(0, 6).map((c: any, i: number) => (
                  <p key={i} className="text-[10px] text-muted-foreground">
                    {c.status === "pass" ? "✅" : c.status === "warning" ? "⚠️" : "❌"} {c.message}
                  </p>
                ))}
                {checks.length > 6 && (
                  <p className="text-[10px] text-muted-foreground">+{checks.length - 6} more</p>
                )}
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

const ChatContextCell = ({ data }: ICellRendererParams) => {
  const chatContext: ChatMessage[] = data.chat_context;
  if (!chatContext || !Array.isArray(chatContext) || chatContext.length === 0) {
    return <span className="text-muted-foreground/40 text-xs italic">—</span>;
  }

  const userMessage = chatContext.find((m: ChatMessage) => m.role === "user");
  const preview = userMessage?.content?.slice(0, 40) || "Chat context";

  return (
    <HoverCard openDelay={200} closeDelay={150}>
      <HoverCardTrigger asChild>
        <button className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors cursor-pointer max-w-full">
          <MessageSquare className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{preview}{(userMessage?.content?.length || 0) > 40 ? "…" : ""}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="left" align="start" className="w-80 p-0 z-[9999]">
        <div className="px-3 py-2 border-b border-border bg-muted/30">
          <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            <MessageSquare className="h-3 w-3" /> Chat That Triggered This Edit
          </p>
        </div>
        <div className="px-3 py-2 space-y-2 max-h-60 overflow-y-auto">
          {chatContext.map((msg: ChatMessage, i: number) => (
            <div key={i} className={`text-xs ${msg.role === "user" ? "text-foreground" : "text-muted-foreground"}`}>
              <span className={`inline-block text-[10px] uppercase tracking-wide font-semibold mb-0.5 ${
                msg.role === "user" ? "text-primary" : "text-muted-foreground"
              }`}>
                {msg.role === "user" ? "You" : "Assistant"}
              </span>
              <p className="leading-relaxed">{msg.content}</p>
            </div>
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
};

export default function DataProvenance() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const gridRef = useRef<AgGridReact>(null);
  const [quickFilter, setQuickFilter] = useState("");
  // Deep-linkable, so "look at the grades for X" can be shared as a URL.
  const [tab, setTab] = useHashState<"history" | "grades">("history", ["history", "grades"] as const);

  const { data: history, isLoading } = useQuery({
    queryKey: ["edit-history-all"],
    queryFn: async () => {
      const { data } = await supabase
        .from("edit_history")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      return data || [];
    },
    enabled: !!user,
  });

  const { data: grants } = useQuery({
    queryKey: ["grants-titles-provenance"],
    queryFn: async () => {
      const { data } = await supabase.from("grants").select("grant_number, title");
      return data || [];
    },
    enabled: !!user,
  });

  // Pull recent curation audit rows so we can offer per-row Revert on edits
  // captured by the new audit pipeline. Older edit_history rows that pre-date
  // the audit pipeline simply won't show a Revert button.
  const { data: auditRows } = useQuery({
    queryKey: ["curation-audit-recent"],
    queryFn: async () => {
      const { data } = await (supabase
        .from("curation_audit_log" as any) as any)
        .select("id, grant_number, field_name, after_value, created_at, reverted_at, entity_type, is_revert")
        .in("entity_type", ["project_metadata", "pending_change_decision"])
        .order("created_at", { ascending: false })
        .limit(1000);
      return (data as any[]) || [];
    },
    enabled: !!user,
  });

  const grantMap = useMemo(() => {
    return new Map((grants || []).map(g => [g.grant_number, g.title]));
  }, [grants]);

  // Index audit rows by (grant_number, field_name) → most recent audit id within 30s of edit_history row
  const auditIndex = useMemo(() => {
    const m = new Map<string, { id: string; reverted: boolean; created_at: string }[]>();
    for (const r of auditRows || []) {
      if (r.is_revert) continue;
      const key = `${r.grant_number}::${r.field_name}`;
      const list = m.get(key) || [];
      list.push({ id: r.id, reverted: !!r.reverted_at, created_at: r.created_at });
      m.set(key, list);
    }
    return m;
  }, [auditRows]);

  const rowData = useMemo<EditRow[]>(() => {
    if (!history) return [];
    return history.map((h: any) => {
      const candidates = auditIndex.get(`${h.grant_number}::${h.field_name}`) || [];
      const histTs = new Date(h.created_at).getTime();
      // pick the audit row whose timestamp is closest to (and within 30s of) this edit_history row
      let match: { id: string; reverted: boolean; created_at: string } | null = null;
      let bestDelta = Infinity;
      for (const c of candidates) {
        const d = Math.abs(new Date(c.created_at).getTime() - histTs);
        if (d < bestDelta && d <= 30_000) {
          bestDelta = d;
          match = c;
        }
      }
      return {
        ...h,
        project_title: grantMap.get(h.grant_number) || "",
        audit_id: match?.id ?? null,
        audit_reverted: match?.reverted ?? false,
      };
    });
  }, [history, grantMap, auditIndex]);

  const handleRevert = useCallback(async (auditId: string) => {
    if (!confirm("Revert this change? The previous value will be restored.")) return;
    const ok = await revertCurationChange(auditId);
    if (ok) {
      queryClient.invalidateQueries({ queryKey: ["edit-history-all"] });
      queryClient.invalidateQueries({ queryKey: ["curation-audit-recent"] });
    }
  }, [queryClient]);

  const RevertCell = useCallback((p: ICellRendererParams) => {
    const row = p.data as EditRow;
    if (!row.audit_id) {
      return <span className="text-[10px] text-muted-foreground italic">—</span>;
    }
    if (row.audit_reverted) {
      return <span className="text-[10px] text-muted-foreground">reverted</span>;
    }
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-6 text-[11px] gap-1"
        onClick={() => handleRevert(row.audit_id!)}
      >
        <Undo2 className="h-3 w-3" /> Revert
      </Button>
    );
  }, [handleRevert]);

  const columnDefs = useMemo<ColDef[]>(() => [
    {
      field: "created_at",
      headerName: "Timestamp",
      width: 160,
      cellRenderer: TimestampCell,
      sort: "desc" as const,
    },
    {
      field: "grant_number",
      headerName: "Project",
      flex: 1,
      minWidth: 200,
      cellRenderer: ProjectCell,
    },
    {
      field: "field_name",
      headerName: "Field",
      width: 180,
      cellRenderer: FieldCell,
    },
    {
      field: "edited_by",
      headerName: "Editor",
      width: 130,
      cellRenderer: EditorCell,
    },
    {
      field: "validation_status",
      headerName: "Validation",
      width: 140,
      cellRenderer: ValidationCell,
    },
    {
      field: "old_value",
      headerName: "Old Value",
      width: 180,
      cellRenderer: ValueCell,
    },
    {
      field: "new_value",
      headerName: "New Value",
      width: 180,
      cellRenderer: ValueCell,
    },
    {
      field: "chat_context",
      headerName: "Chat",
      width: 200,
      cellRenderer: ChatContextCell,
    },
    {
      headerName: "Action",
      width: 110,
      sortable: false,
      filter: false,
      cellRenderer: RevertCell,
    },
  ], [RevertCell]);

  const defaultColDef = useMemo<ColDef>(() => ({
    sortable: true,
    resizable: true,
    suppressMovable: true,
    unSortIcon: true,
  }), []);

  const onFilterChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuickFilter(e.target.value);
  }, []);

  // Auth gate - after all hooks
  if (!user) {
    return (
      <div className="h-[calc(100vh-4rem)] flex items-center justify-center bg-background">
        <div className="text-center space-y-4 max-w-sm px-6">
          <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
            <LogIn className="h-6 w-6 text-primary" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">Sign in to view Data Provenance</h2>
          <p className="text-sm text-muted-foreground">
            The audit log is available to authenticated consortium members.
          </p>
          <Link to="/auth">
            <Button className="mt-2">Sign In</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col bg-background">
      {/* Header */}
      <div className="border-b border-border px-6 py-4 shrink-0 bg-card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
              <History className="h-4 w-4 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-foreground leading-tight">Data Provenance</h1>
              <p className="text-[11px] text-muted-foreground">
                Track all metadata changes across the consortium
              </p>
            </div>
            <Badge variant="secondary" className="text-xs ml-2">
              {rowData.length} edits
            </Badge>
            {/* Two questions, one page: what changed, and how good is what is here now. Splitting
                them across two consoles is the duplication this whole feature exists to remove. */}
            <div className="flex items-center gap-1 ml-4 border border-border rounded-md p-0.5">
              {([["history", "Change history"], ["grades", "Field grades"]] as const).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={cn(
                    "text-[11px] px-2.5 py-1 rounded transition-colors",
                    tab === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {tab === "history" && (
            <div className="relative max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={quickFilter}
                onChange={onFilterChange}
                placeholder="Filter edits..."
                className="pl-9 h-8 text-xs"
              />
            </div>
          )}
        </div>
      </div>

      {/* Field grades */}
      {tab === "grades" && (
        <div className="flex-1 overflow-hidden">
          <ProvenanceGrades />
        </div>
      )}

      {/* AG Grid */}
      {tab === "history" && (
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="ag-grid-mobile-wrapper">
          <div className="ag-theme-alpine h-full w-full">
            <AgGridReact
              ref={gridRef}
              rowData={rowData}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              quickFilterText={quickFilter}
              animateRows
              pagination
              paginationPageSize={100}
              paginationPageSizeSelector={[25, 50, 100, 200]}
              suppressCellFocus
              enableCellTextSelection
              rowHeight={40}
              headerHeight={36}
            />
          </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
