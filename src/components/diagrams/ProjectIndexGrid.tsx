import { useMemo, useState, useCallback } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import "@/styles/ag-grid-theme.css";
import { type MarrProject } from "@/data/marr-projects";
import { useMarrProjects } from "@/hooks/useMarrProjects";
import { Badge } from "@/components/ui/badge";
import { Code, List, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const FeatureBadges = ({ value }: { value: string[] }) => {
  if (!value || value.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1 py-1">
      {value.map((f) => (
        <Badge key={f} variant="outline" className="text-[10px] px-1.5 py-0 whitespace-nowrap">
          {f}
        </Badge>
      ))}
    </div>
  );
};

const SpeciesBadge = ({ value, data }: { value: string; data: MarrProject }) => (
  <div className="flex items-center gap-2">
    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: data.color }} />
    <span className="text-sm">{value}</span>
  </div>
);

function ProjectDetailModal({ project, open, onClose }: { project: MarrProject; open: boolean; onClose: () => void }) {
  const [view, setView] = useState<"list" | "json">("list");
  const [copied, setCopied] = useState(false);

  const jsonData = useMemo(() => JSON.stringify(project, null, 2), [project]);

  const copyJson = useCallback(() => {
    navigator.clipboard.writeText(jsonData);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [jsonData]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full" style={{ background: project.color }} />
            {project.shortName}
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={() => setView("list")}
            className={cn(
              "flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium transition-colors",
              view === "list" ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"
            )}
          >
            <List className="h-3.5 w-3.5" /> Fields
          </button>
          <button
            onClick={() => setView("json")}
            className={cn(
              "flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium transition-colors",
              view === "json" ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"
            )}
          >
            <Code className="h-3.5 w-3.5" /> JSON
          </button>
        </div>

        {view === "list" ? (
          <div className="space-y-3 text-sm">
            {Object.entries(project).map(([key, val]) => (
              <div key={key} className="border-b border-border pb-2">
                <span className="text-xs font-mono text-muted-foreground">{key}</span>
                <div className="mt-0.5 text-foreground">
                  {Array.isArray(val) ? (
                    <div className="flex flex-wrap gap-1">
                      {val.map((v, i) => (
                        <Badge key={i} variant="outline" className="text-[10px]">
                          {String(v)}
                        </Badge>
                      ))}
                      {val.length === 0 && <span className="text-muted-foreground">—</span>}
                    </div>
                  ) : (
                    <span>{String(val)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="relative">
            <button
              onClick={copyJson}
              className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded bg-secondary text-secondary-foreground text-xs"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
            <pre className="bg-muted p-4 rounded-lg text-xs overflow-x-auto font-mono text-foreground">
              {jsonData}
            </pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ProjectIndexGrid() {
  const { projects, loading } = useMarrProjects();
  const [selectedProject, setSelectedProject] = useState<MarrProject | null>(null);

  const defaultColDef = useMemo<ColDef>(() => ({
    sortable: true,
    filter: true,
    resizable: true,
    wrapText: true,
    autoHeight: true,
    cellStyle: { lineHeight: "1.5", padding: "6px 10px" },
  }), []);

  const columnDefs = useMemo<ColDef<MarrProject>[]>(() => [
    {
      field: "shortName",
      headerName: "Project",
      minWidth: 200,
      flex: 1,
      cellRenderer: (params: ICellRendererParams<MarrProject>) => (
        <button
          className="text-primary hover:text-primary/80 font-medium transition-colors text-left"
          onClick={() => setSelectedProject(params.data ?? null)}
        >
          {params.value}
        </button>
      ),
    },
    {
      field: "pi",
      headerName: "PI",
      width: 160,
    },
    {
      field: "species",
      headerName: "Species",
      width: 130,
      cellRenderer: SpeciesBadge,
    },
    {
      field: "computational",
      headerName: "Goals",
      minWidth: 180,
      flex: 1,
      cellRenderer: FeatureBadges,
    },
    {
      field: "algorithmic",
      headerName: "Methods",
      minWidth: 180,
      flex: 1,
      cellRenderer: FeatureBadges,
    },
    {
      field: "implementation",
      headerName: "Resources",
      minWidth: 180,
      flex: 1,
      cellRenderer: FeatureBadges,
    },
  ], []);

  if (loading) {
    return <div className="flex items-center justify-center h-40 text-muted-foreground">Loading projects from YAML...</div>;
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Project Index</h2>
        <span className="text-xs text-muted-foreground">Click a project name to view full data structure</span>
      </div>
      <div
        className="ag-theme-alpine"
        style={{ height: Math.min(700, projects.length * 48 + 56) }}
      >
        <AgGridReact
          rowData={projects}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          animateRows={true}
          suppressCellFocus={true}
          enableCellTextSelection={true}
          getRowId={(params) => params.data.id}
        />
      </div>

      {selectedProject && (
        <ProjectDetailModal
          project={selectedProject}
          open={!!selectedProject}
          onClose={() => setSelectedProject(null)}
        />
      )}
    </div>
  );
}
