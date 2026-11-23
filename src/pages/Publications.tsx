import { useMemo, useRef, useState, useCallback } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileCardList } from "@/components/MobileCardList";
import { useSearchParams } from "react-router-dom";
import { AgGridReact } from "ag-grid-react";
import { ColDef, GridReadyEvent, CellMouseOverEvent } from "ag-grid-community";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Download, RefreshCw, Plus } from "lucide-react";
import { piProfileUrl } from "@/lib/pi-utils";
import { useEntitySummary } from "@/contexts/EntitySummaryContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { toast } from "sonner";
import { alreadyInKgMessage } from "@/lib/alreadyInKg";

import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";

interface AuthorOrcid { name: string; orcid: string; }

interface PubFormData {
  title: string;
  authors: string;
  year: string;
  journal: string;
  doi: string;
}

const INITIAL_PUB_FORM: PubFormData = {
  title: "", authors: "", year: String(new Date().getFullYear()), journal: "", doi: "",
};

interface Publication {
  id: string; pmid: string; title: string; year: number; journal: string; authors: string;
  citations: number; rcr: number; grantNumber: string; pubmedLink: string;
  keywords: string[]; authorOrcids: AuthorOrcid[]; resourceId?: string;
}

const fetchPublications = async (): Promise<Publication[]> => {
  const { data, error } = await supabase.from("publications").select("*").order("citations", { ascending: false });
  if (error) throw error;
  if (!data) return [];
  return data.map((pub) => ({
    id: pub.id,
    pmid: pub.pmid || "", title: pub.title, year: pub.year || 0, journal: pub.journal || "",
    authors: pub.authors || "", citations: pub.citations || 0, rcr: Number(pub.rcr) || 0, grantNumber: "",
    pubmedLink: pub.pubmed_link || (pub.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pub.pmid}/` : ""),
    keywords: Array.isArray(pub.keywords) ? pub.keywords : [],
    authorOrcids: Array.isArray(pub.author_orcids) ? (pub.author_orcids as unknown as AuthorOrcid[]) : [],
    resourceId: pub.resource_id || undefined,
  }));
};

const TitleCell = ({ value, data }: { value: string; data: Publication }) => {
  const { open } = useEntitySummary();
  if (!data?.id) return <span>{value}</span>;
  return (
    <button
      onClick={() => open({ type: "publication", id: data.id, resourceId: data.resourceId, label: data.title })}
      className="text-primary hover:text-primary/80 hover:underline inline-flex items-center gap-1.5 font-medium transition-colors text-left">
      {value}
    </button>
  );
};

const parseAuthorPairs = (raw: string): string[] => {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const authors: string[] = [];
  let i = 0;
  while (i < parts.length) {
    if (i + 1 < parts.length) {
      const next = parts[i + 1];
      const looksLikeFirstName = /^[A-Z][a-z]/.test(next) || /^[A-Z]{1,3}$/.test(next);
      if (looksLikeFirstName) { authors.push(`${next} ${parts[i]}`); i += 2; continue; }
    }
    authors.push(parts[i]); i += 1;
  }
  return authors;
};

const AuthorsCell = ({ value, data }: { value: string; data: Publication }) => {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const authors = parseAuthorPairs(value);
  if (authors.length === 0) return <span className="text-muted-foreground">—</span>;
  const orcidMap = new Map<string, string>();
  if (data?.authorOrcids) {
    for (const ao of data.authorOrcids) {
      const parts = ao.name.split(",").map(s => s.trim());
      const lastName = parts[0]?.toLowerCase() || "";
      if (lastName) orcidMap.set(lastName, ao.orcid);
    }
  }
  const getAuthorUrl = (author: string): string => {
    const parts = author.trim().split(/\s+/);
    const lastName = parts[parts.length - 1]?.toLowerCase() || "";
    const orcid = orcidMap.get(lastName);
    if (orcid) return `https://orcid.org/${orcid}`;
    return piProfileUrl(author);
  };
  return (
    <span className="flex flex-wrap gap-x-1 gap-y-0.5 py-1" style={{ whiteSpace: 'normal', lineHeight: '1.5' }}>
      {authors.map((author, i) => {
        const url = getAuthorUrl(author);
        let isOrcid = false;
        try { const h = new URL(url).hostname; isOrcid = h === "orcid.org" || h.endsWith(".orcid.org"); } catch { isOrcid = false; }
        return (
          <span key={i} className="whitespace-nowrap">
            <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline"
              title={isOrcid ? `View ${author} on ORCID` : `Search ${author} on Google Scholar`}>{author}</a>
            {i < authors.length - 1 ? "," : ""}
          </span>
        );
      })}
    </span>
  );
};

const KEYWORD_COLORS = [
  "bg-primary/15 text-primary border-primary/25",
  "bg-accent/15 text-accent-foreground border-accent/25",
  "bg-secondary text-secondary-foreground border-secondary",
  "bg-muted text-muted-foreground border-muted",
];

const KeywordsCell = ({ value }: { value: string[] }) => {
  if (!value || value.length === 0) return <span className="text-muted-foreground">—</span>;
  const displayed = value.slice(0, 3);
  const remaining = value.length - displayed.length;
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span className="flex flex-wrap gap-1 py-1 cursor-pointer">
          {displayed.map((kw, i) => (
            <Badge key={i} variant="outline" className={`text-[10px] px-1.5 py-0.5 font-normal whitespace-nowrap ${KEYWORD_COLORS[i % KEYWORD_COLORS.length]}`}>{kw}</Badge>
          ))}
          {remaining > 0 && <Badge variant="outline" className="text-[10px] px-1.5 py-0.5 font-normal text-muted-foreground">+{remaining}</Badge>}
        </span>
      </HoverCardTrigger>
      <HoverCardContent className="w-72 z-[9999]" side="left" align="start">
        <p className="text-xs font-semibold mb-2 text-foreground">All Keywords</p>
        <div className="flex flex-wrap gap-1.5">
          {value.map((kw, i) => (
            <Badge key={i} variant="outline" className={`text-[11px] px-2 py-0.5 font-normal ${KEYWORD_COLORS[i % KEYWORD_COLORS.length]}`}>{kw}</Badge>
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
};

export default function Publications() {
  const isMobile = useIsMobile();
  const gridRef = useRef<AgGridReact>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const grantFilter = searchParams.get("grant");
  const [quickFilterText, setQuickFilterText] = useState(searchParams.get("q") || "");
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pubForm, setPubForm] = useState<PubFormData>(INITIAL_PUB_FORM);

  const { data: publications = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ["publications"], queryFn: fetchPublications, staleTime: 5 * 60 * 1000, gcTime: 30 * 60 * 1000,
  });

  const addPublication = useMutation({
    mutationFn: async (data: PubFormData) => {
      if (!user) throw new Error("Must be signed in");
      const { error } = await supabase.from("publications").insert({
        title: data.title.trim(),
        authors: data.authors.trim() || null,
        year: data.year ? Number(data.year) : null,
        journal: data.journal.trim() || null,
        doi: data.doi.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["publications"] });
      setDialogOpen(false);
      setPubForm(INITIAL_PUB_FORM);
      toast.success("Publication added successfully!");
    },
    // A DOI already in the KG (uq_publications_doi_key, 20261117181500) is said as such; any other
    // error as it came.
    onError: (err: any, vars) => toast.error(alreadyInKgMessage(err, { doi: vars?.doi }) ?? (err.message || "Failed to add publication")),
  });

  const handlePubSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pubForm.title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (!pubForm.authors.trim()) {
      toast.error("Authors are required");
      return;
    }
    if (!pubForm.year) {
      toast.error("Year is required");
      return;
    }
    addPublication.mutate(pubForm);
  };

  const displayedPubs = useMemo(() => {
    if (!grantFilter) return publications;
    return publications.filter((p) => p.grantNumber === grantFilter);
  }, [publications, grantFilter]);

  const columnDefs: ColDef<Publication>[] = useMemo(() => [
    { field: "title", headerName: "Title", flex: 2, minWidth: 300, cellRenderer: TitleCell, cellStyle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
    { field: "keywords", headerName: "Keywords", flex: 1, minWidth: 220, cellRenderer: KeywordsCell, autoHeight: true, cellStyle: { overflow: 'visible', lineHeight: '1.4' }, filter: "agTextColumnFilter", filterValueGetter: (params) => params.data?.keywords?.join(", ") || "" },
    { field: "citations", headerName: "Citations", width: 100, flex: 0, sort: "desc" },
  ], []);

  const defaultColDef: ColDef = useMemo(() => ({ sortable: true, filter: true, resizable: true }), []);
  const onGridReady = (params: GridReadyEvent) => { params.api.sizeColumnsToFit(); };

  const onCellMouseOver = useCallback((event: CellMouseOverEvent) => {}, []);
  const onCellMouseOut = useCallback(() => {}, []);

  const exportToCSV = () => { gridRef.current?.api.exportDataAsCsv({ fileName: "publications.csv" }); };
  const clearFilter = () => { setSearchParams({}); };

  return (
    <div className="container mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Publications</h1>
          <p className="text-muted-foreground">Papers from NIH-funded research grants</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={exportToCSV}>
            <Download className="h-4 w-4 mr-2" />Export CSV
          </Button>
          {user && (
            <Dialog
              open={dialogOpen}
              onOpenChange={(open) => {
                setDialogOpen(open);
                if (!open) setPubForm(INITIAL_PUB_FORM);
              }}
            >
              <DialogTrigger asChild>
                <Button size="sm" className="gap-2">
                  <Plus className="h-4 w-4" />
                  Add Publication
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Add a Publication</DialogTitle>
                </DialogHeader>
                <form onSubmit={handlePubSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="pub-title">Title *</Label>
                    <Input
                      id="pub-title"
                      value={pubForm.title}
                      onChange={e => setPubForm(f => ({ ...f, title: e.target.value }))}
                      placeholder="Full publication title"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pub-authors">Authors *</Label>
                    <Input
                      id="pub-authors"
                      value={pubForm.authors}
                      onChange={e => setPubForm(f => ({ ...f, authors: e.target.value }))}
                      placeholder="Smith J, Doe A, ..."
                      required
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="pub-year">Year *</Label>
                      <Input
                        id="pub-year"
                        type="number"
                        value={pubForm.year}
                        onChange={e => setPubForm(f => ({ ...f, year: e.target.value }))}
                        min={1900}
                        max={new Date().getFullYear()}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="pub-journal">Journal</Label>
                      <Input
                        id="pub-journal"
                        value={pubForm.journal}
                        onChange={e => setPubForm(f => ({ ...f, journal: e.target.value }))}
                        placeholder="e.g. Nature Neuroscience"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pub-doi">DOI</Label>
                    <Input
                      id="pub-doi"
                      value={pubForm.doi}
                      onChange={e => setPubForm(f => ({ ...f, doi: e.target.value }))}
                      placeholder="10.xxxx/..."
                    />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button type="submit" className="flex-1" disabled={addPublication.isPending}>
                      {addPublication.isPending ? "Adding..." : "Add Publication"}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      <div className="bg-card rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center gap-4 mb-4">
          <input type="text" placeholder="Quick filter..." value={quickFilterText}
            onChange={(e) => setQuickFilterText(e.target.value)}
            className="px-4 py-2 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary w-full max-w-md text-sm" />
          <span className="text-sm text-muted-foreground">{displayedPubs.length} publications</span>
          {grantFilter && (
            <span className="flex items-center gap-2">
              <span className="bg-primary/10 text-primary border border-primary/30 rounded-full px-3 py-0.5 text-xs font-medium">Grant: {grantFilter}</span>
              <button onClick={clearFilter} className="text-xs text-muted-foreground hover:text-foreground underline">Show all</button>
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
        ) : isMobile ? (
          <MobileCardList
            items={displayedPubs
              .filter((p) => !quickFilterText || p.title.toLowerCase().includes(quickFilterText.toLowerCase()) || p.authors.toLowerCase().includes(quickFilterText.toLowerCase()))
              .map((p) => ({
                id: p.pmid || p.title, title: p.title, titleHref: p.pubmedLink,
                fields: [
                  { label: "Year", value: String(p.year || "—") },
                  { label: "Journal", value: p.journal || "—" },
                  { label: "Citations", value: String(p.citations) },
                  { label: "RCR", value: p.rcr ? p.rcr.toFixed(2) : "—" },
                ],
              }))}
            emptyMessage="No publications found"
          />
        ) : (
          <div className="ag-theme-alpine relative" style={{ width: "100%" }}>
            <AgGridReact ref={gridRef} rowData={displayedPubs} columnDefs={columnDefs} defaultColDef={defaultColDef}
              onGridReady={onGridReady} quickFilterText={quickFilterText} rowHeight={44} headerHeight={40}
              animateRows domLayout="autoHeight" suppressCellFocus={true} enableCellTextSelection={true} />
          </div>
        )}
      </div>
    </div>
  );
}
