"use client";

import { useSearchParams } from "react-router-dom";
import { useState, useMemo, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import type { Resource } from "@/data/resources";
import { useResources } from "@/hooks/useResources";
import { useUserTier } from "@/hooks/useUserTier";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileCardList } from "@/components/MobileCardList";
import { useEntitySummary } from "@/contexts/EntitySummaryContext";
import "@/styles/ag-grid-theme.css";

interface ResourceForm {
  name: string;
  category: string;
  algorithm: string;
  url: string;
}

const INITIAL_RESOURCE_FORM: ResourceForm = {
  name: "",
  category: "",
  algorithm: "",
  url: "",
};

// Top-level filter categories.
// Software group: Software (tools/apps), Libraries (code libs), ML Models
// Data group: Datasets
// Methods group: Benchmarks, Protocols
const CATEGORIES = ["All", "Software", "Libraries", "ML Models", "Datasets", "Benchmarks", "Protocols"] as const;
type Category = typeof CATEGORIES[number];

const CATEGORY_TO_RESOURCE_TYPE: Record<string, "software" | "ml_model" | "dataset" | "benchmark" | "protocol"> = {
  Software: "software",
  Libraries: "software",
  "ML Models": "ml_model",
  Datasets: "dataset",
  Benchmarks: "benchmark",
  Protocols: "protocol",
};

const categoryColors: Record<string, string> = {
  Software:    "bg-blue-500/20 text-blue-400 border-blue-500/30",
  Libraries:   "bg-sky-500/20 text-sky-400 border-sky-500/30",
  "ML Models": "bg-purple-500/20 text-purple-400 border-purple-500/30",
  Datasets:    "bg-green-500/20 text-green-400 border-green-500/30",
  Benchmarks:  "bg-orange-500/20 text-orange-400 border-orange-500/30",
  Protocols:   "bg-pink-500/20 text-pink-400 border-pink-500/30",
};

const CategoryBadge = ({ value }: { value: string }) => (
  <Badge variant="outline" className={`${categoryColors[value] || ""} text-xs`}>
    {value}
  </Badge>
);

const NameCell = ({ value, data }: { value: string; data: Resource }) => {
  const { open } = useEntitySummary();

  const handleClick = async () => {
    if (data.id) {
      open({
        type: "dataset", // generic — ResourceSummary handles all types
        id: String(data.id),
        label: data.name,
      });
    }
  };

  return (
    <button
      onClick={handleClick}
      className="text-primary hover:underline font-semibold text-sm cursor-pointer text-left"
    >
      {value}
    </button>
  );
};

const columnDefs: ColDef<Resource>[] = [
  { field: "name", headerName: "Name", minWidth: 200, flex: 1.5, cellRenderer: NameCell },
  {
    field: "algorithm", headerName: "Description", minWidth: 300, flex: 3,
    wrapText: true, autoHeight: true,
    cellStyle: { lineHeight: '1.4', paddingTop: '8px', paddingBottom: '8px', whiteSpace: 'normal', wordBreak: 'break-word' },
  },
  { field: "category", headerName: "Type", width: 130, minWidth: 130, cellRenderer: CategoryBadge },
];

const Resources = () => {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [quickFilterText, setQuickFilterText] = useState(searchParams.get("q") || "");
  const [activeCategory, setActiveCategory] = useState<Category>("All");
  const { data: allResources = [], isLoading } = useResources();
  const { open } = useEntitySummary();
  const { isCurator } = useUserTier();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<ResourceForm>(INITIAL_RESOURCE_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleResourceSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!form.category) {
      toast.error("Category is required");
      return;
    }
    setIsSubmitting(true);
    try {
      // resources has no category/algorithm/url columns: the type is an enum and the display
      // category lives in metadata (see mapDbToResource in useResources).
      const description = form.algorithm.trim() || null;
      const { error } = await supabase.from("resources").insert({
        name: form.name.trim(),
        resource_type: CATEGORY_TO_RESOURCE_TYPE[form.category],
        description,
        external_url: form.url.trim() || null,
        metadata: { category: form.category, algorithm: description },
      });
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ["resources"] });
      setDialogOpen(false);
      setForm(INITIAL_RESOURCE_FORM);
      toast.success("Resource added!");
    } catch (err: any) {
      toast.error(err.message || "Failed to add resource");
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredResources = useMemo(() => {
    if (activeCategory === "All") return allResources;
    return allResources.filter(r => r.category === activeCategory);
  }, [allResources, activeCategory]);

  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true, unSortIcon: true }), []);

  return (
    <div className="min-h-screen bg-background">
      <div className="px-6 py-8">
        <div className="mb-6">
          <div className="flex items-start justify-between gap-4 mb-2">
            <h1 className="text-3xl font-bold text-foreground">Resources</h1>
            {isCurator && (
              <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogTrigger asChild>
                  <Button size="lg" className="gap-2 shadow-lg shadow-primary/20">
                    <Plus className="h-4 w-4" />
                    Add Resource
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>Add Resource</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={handleResourceSubmit} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="r-name">Name *</Label>
                      <Input
                        id="r-name"
                        value={form.name}
                        onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                        placeholder="e.g. DeepLabCut"
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="r-category">Category *</Label>
                      <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v }))}>
                        <SelectTrigger id="r-category">
                          <SelectValue placeholder="Select a category" />
                        </SelectTrigger>
                        <SelectContent>
                          {(["Software", "Libraries", "ML Models", "Datasets", "Benchmarks", "Protocols"] as const).map(cat => (
                            <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="r-algorithm">Description (optional)</Label>
                      <Textarea
                        id="r-algorithm"
                        value={form.algorithm}
                        onChange={e => setForm(f => ({ ...f, algorithm: e.target.value }))}
                        placeholder="Brief description of the resource..."
                        rows={3}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="r-url">URL (optional)</Label>
                      <Input
                        id="r-url"
                        value={form.url}
                        onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                        placeholder="https://..."
                      />
                    </div>
                    <div className="flex gap-3 pt-1">
                      <Button type="submit" className="flex-1" disabled={isSubmitting}>
                        {isSubmitting ? "Saving..." : "Add Resource"}
                      </Button>
                      <Button type="button" variant="outline" className="flex-1" onClick={() => { setDialogOpen(false); setForm(INITIAL_RESOURCE_FORM); }}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                </DialogContent>
              </Dialog>
            )}
          </div>
          <p className="text-muted-foreground mb-4">
            Browse software, libraries, ML models, datasets, benchmarks, and protocols. Click any resource to view its full details.
          </p>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {/* "All" filter */}
            <button
              key="All"
              onClick={() => setActiveCategory("All")}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                activeCategory === "All"
                  ? "bg-primary/20 text-primary border-primary/30"
                  : "bg-muted/30 text-muted-foreground border-border hover:bg-muted/50"
              }`}
            >
              All
            </button>
            {/* Software group divider */}
            <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider px-1">Software</span>
            {(["Software", "Libraries", "ML Models"] as const).map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                  activeCategory === cat ? categoryColors[cat] : "bg-muted/30 text-muted-foreground border-border hover:bg-muted/50"
                }`}
              >
                {cat}
              </button>
            ))}
            {/* Data / methods divider */}
            <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider px-1">Data &amp; Methods</span>
            {(["Datasets", "Benchmarks", "Protocols"] as const).map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                  activeCategory === cat ? categoryColors[cat] : "bg-muted/30 text-muted-foreground border-border hover:bg-muted/50"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-4 mb-4">
            <input type="text" placeholder="Quick filter..." value={quickFilterText}
              onChange={(e) => setQuickFilterText(e.target.value)}
              className="px-4 py-2 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary w-full max-w-md" />
            <span className="text-sm text-muted-foreground">{filteredResources.length} resources</span>
          </div>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading resources...
          </div>
        ) : isMobile ? (
          <MobileCardList
            items={filteredResources
              .filter((r) => !quickFilterText || r.name.toLowerCase().includes(quickFilterText.toLowerCase()) || r.algorithm?.toLowerCase().includes(quickFilterText.toLowerCase()))
              .map((r) => ({
                id: String(r.id || r.name),
                title: r.name,
                fields: [
                  { label: "Type", value: <CategoryBadge value={r.category} /> },
                  { label: "Description", value: <span className="line-clamp-2">{r.algorithm || "—"}</span> },
                ],
              }))}
            emptyMessage="No resources found"
          />
        ) : (
          <div className="ag-theme-alpine rounded-lg border border-border overflow-hidden">
            <AgGridReact<Resource>
              rowData={filteredResources}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              quickFilterText={quickFilterText}
              animateRows={true}
              suppressCellFocus={true}
              enableCellTextSelection={true}
              headerHeight={40}
              domLayout="autoHeight"
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default Resources;
