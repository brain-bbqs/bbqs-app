import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import "@/styles/ag-grid-theme.css";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileCardList } from "@/components/MobileCardList";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

type Usage = {
  grant_number: string;
  grant_title: string | null;
  category_key: string;
  category_label: string;
  measures: string[] | null;
  evidence_terms: string[] | null;
  evidence_count: number;
  catalog_models: number;
};

type ProjectRow = {
  grant_number: string;
  grant_title: string;
  categories: string[];
  measures: string[];
  catalog_models: number;
};

type CategoryRow = {
  category_key: string;
  category_label: string;
  projects: string[];
  project_count: number;
  catalog_models: number;
};

export function DeviceProjectMap() {
  const [usage, setUsage] = useState<Usage[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const isMobile = useIsMobile();

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("project_device_usage" as any)
        .select("grant_number,grant_title,category_key,category_label,measures,evidence_terms,evidence_count,catalog_models")
        .order("grant_number");
      setUsage((data as any) || []);
      setLoading(false);
    })();
  }, []);

  const byProject = useMemo<ProjectRow[]>(() => {
    const m = new Map<string, ProjectRow>();
    for (const u of usage) {
      const row =
        m.get(u.grant_number) ??
        { grant_number: u.grant_number, grant_title: u.grant_title || "—", categories: [], measures: [], catalog_models: 0 };
      if (!row.categories.includes(u.category_label)) row.categories.push(u.category_label);
      for (const meas of u.measures || []) if (!row.measures.includes(meas)) row.measures.push(meas);
      row.catalog_models += u.catalog_models;
      m.set(u.grant_number, row);
    }
    return [...m.values()].sort((a, b) => b.categories.length - a.categories.length);
  }, [usage]);

  const byCategory = useMemo<CategoryRow[]>(() => {
    const m = new Map<string, CategoryRow>();
    for (const u of usage) {
      const row =
        m.get(u.category_key) ??
        { category_key: u.category_key, category_label: u.category_label, projects: [], project_count: 0, catalog_models: u.catalog_models };
      if (!row.projects.includes(u.grant_number)) row.projects.push(u.grant_number);
      row.project_count = row.projects.length;
      m.set(u.category_key, row);
    }
    return [...m.values()].sort((a, b) => b.project_count - a.project_count);
  }, [usage]);

  const needle = q.trim().toLowerCase();
  const match = (s: string) => !needle || s.toLowerCase().includes(needle);
  const projectRows = byProject.filter((r) => match(`${r.grant_number} ${r.grant_title} ${r.categories.join(" ")} ${r.measures.join(" ")}`));
  const categoryRows = byCategory.filter((r) => match(`${r.category_label} ${r.category_key} ${r.projects.join(" ")}`));

  const badgeCell = (values: string[], max = 6) => (
    <div className="flex flex-wrap gap-1 py-1">
      {values.slice(0, max).map((v) => (
        <Badge key={v} variant="secondary" className="text-[11px]">{v}</Badge>
      ))}
      {values.length > max && <Badge variant="outline" className="text-[11px]">+{values.length - max}</Badge>}
    </div>
  );

  const defaultColDef: ColDef = { sortable: true, filter: true, resizable: true, wrapText: true, autoHeight: true };

  const projectCols: ColDef<ProjectRow>[] = [
    {
      headerName: "Project",
      field: "grant_number",
      minWidth: 160,
      cellRenderer: (p: any) => (
        <Link to={`/projects/${p.data.grant_number}/profile`} className="text-primary hover:underline font-medium">
          {p.data.grant_number}
        </Link>
      ),
    },
    { headerName: "Title", field: "grant_title", flex: 2, minWidth: 260 },
    {
      headerName: "Device categories",
      field: "categories",
      flex: 2,
      minWidth: 260,
      cellRenderer: (p: any) => badgeCell(p.data.categories),
    },
    {
      headerName: "Measures",
      field: "measures",
      flex: 2,
      minWidth: 220,
      cellRenderer: (p: any) => badgeCell(p.data.measures, 5),
    },
    { headerName: "Catalog products", field: "catalog_models", width: 150 },
  ];

  const categoryCols: ColDef<CategoryRow>[] = [
    { headerName: "Device category", field: "category_label", flex: 1, minWidth: 200 },
    { headerName: "Projects", field: "project_count", width: 120 },
    {
      headerName: "Grant numbers",
      field: "projects",
      flex: 3,
      minWidth: 320,
      cellRenderer: (p: any) => (
        <div className="flex flex-wrap gap-1 py-1">
          {p.data.projects.map((g: string) => (
            <Link key={g} to={`/projects/${g}/profile`} className="text-primary hover:underline text-xs">{g}</Link>
          ))}
        </div>
      ),
    },
    { headerName: "Catalog products", field: "catalog_models", width: 150 },
  ];

  if (loading) return <p className="text-sm text-muted-foreground">Loading device–project map…</p>;

  return (
    <div className="space-y-4">
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search projects, categories, measures…"
          className="w-full pl-9 pr-4 py-2 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      <Tabs defaultValue="project">
        <TabsList>
          <TabsTrigger value="project">By project</TabsTrigger>
          <TabsTrigger value="category">By device</TabsTrigger>
        </TabsList>

        <TabsContent value="project" className="pt-4">
          {isMobile ? (
            <MobileCardList
              items={projectRows}
              getKey={(r) => r.grant_number}
              renderCard={(r) => (
                <div className="space-y-2">
                  <Link to={`/projects/${r.grant_number}/profile`} className="text-primary font-medium">{r.grant_number}</Link>
                  <p className="text-sm text-muted-foreground">{r.grant_title}</p>
                  {badgeCell(r.categories)}
                </div>
              )}
            />
          ) : (
            <div className="ag-theme-alpine w-full">
              <AgGridReact<ProjectRow>
                rowData={projectRows}
                columnDefs={projectCols}
                defaultColDef={defaultColDef}
                domLayout="autoHeight"
                pagination={projectRows.length > 25}
                paginationPageSize={25}
              />
            </div>
          )}
        </TabsContent>

        <TabsContent value="category" className="pt-4">
          {isMobile ? (
            <MobileCardList
              items={categoryRows}
              getKey={(r) => r.category_key}
              renderCard={(r) => (
                <div className="space-y-2">
                  <p className="font-medium">{r.category_label}</p>
                  <p className="text-sm text-muted-foreground">{r.project_count} projects · {r.catalog_models} catalog products</p>
                  {badgeCell(r.projects)}
                </div>
              )}
            />
          ) : (
            <div className="ag-theme-alpine w-full">
              <AgGridReact<CategoryRow>
                rowData={categoryRows}
                columnDefs={categoryCols}
                defaultColDef={defaultColDef}
                domLayout="autoHeight"
              />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
