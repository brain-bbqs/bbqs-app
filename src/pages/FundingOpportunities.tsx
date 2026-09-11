import { useEffect, useMemo, useState, useCallback } from "react";
import { AgGridReact } from "ag-grid-react";
import { ColDef, RowClickedEvent } from "ag-grid-community";
import "ag-grid-community/styles/ag-theme-alpine.css";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, DollarSign, Calendar, AlertCircle, Plus, BookOpen } from "lucide-react";
import { format, differenceInDays, parseISO } from "date-fns";
import { PageMeta } from "@/components/PageMeta";
import { FundingDetailPanel } from "@/components/funding/FundingDetailPanel";
import { AddFundingOpportunityDialog } from "@/components/funding/AddFundingOpportunityDialog";
import { useUserTier } from "@/hooks/useUserTier";

interface FundingOpportunity {
  id: string;
  fon: string;
  title: string;
  activity_code: string | null;
  announcement_type: string | null;
  participating_orgs: string[] | null;
  purpose: string | null;
  posted_date: string | null;
  open_date: string | null;
  expiration_date: string | null;
  due_dates: any[] | null;
  url: string | null;
  status: string;
  relevance_tags: string[] | null;
  eligible_activity_codes: string[] | null;
  budget_ceiling: number | null;
  notes: string | null;
}

const StatusRenderer = ({ value }: { value: string }) => {
  const colorMap: Record<string, string> = {
    open: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    closed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    upcoming: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  };
  return (
    <Badge className={`${colorMap[value] || ""} font-medium`}>
      {value?.charAt(0).toUpperCase() + value?.slice(1)}
    </Badge>
  );
};

const DueDatesRenderer = ({ value }: { value: any[] | null }) => {
  if (!value || value.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-0.5 py-1">
      {value.map((d: any, i: number) => {
        const date = parseISO(d.date);
        const daysLeft = differenceInDays(date, new Date());
        const isUrgent = daysLeft >= 0 && daysLeft <= 30;
        return (
          <div key={i} className="flex items-center gap-1.5 text-xs">
            <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className={isUrgent ? "text-orange-600 dark:text-orange-400 font-semibold" : ""}>
              {format(date, "MMM d, yyyy")}
            </span>
            <span className="text-muted-foreground">({d.type})</span>
            {isUrgent && daysLeft >= 0 && (
              <span className="text-orange-600 dark:text-orange-400 font-bold text-[10px]">
                {daysLeft}d left
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};

const TagsRenderer = ({ value }: { value: string[] | null }) => {
  if (!value || value.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 py-1">
      {value.map((tag, i) => (
        <Badge key={i} variant="outline" className="text-[10px] px-1.5 py-0">
          {tag}
        </Badge>
      ))}
    </div>
  );
};

const LinkRenderer = ({ value, data }: { value: string | null; data: FundingOpportunity }) => {
  if (!value) return null;
  return (
    <a
      href={value}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:underline inline-flex items-center gap-1 text-xs"
    >
      <ExternalLink className="h-3 w-3" />
      View NOFO
    </a>
  );
};

const BudgetRenderer = ({ value }: { value: number | null }) => {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <DollarSign className="h-3 w-3 text-muted-foreground" />
      {value.toLocaleString("en-US")}
    </span>
  );
};

// "Funding resources" strip atop the grants page — funding-FINDER links (resources with
// resource_type='funding'), distinct from the structured NIH FOA list below. Added by the
// BBQS agent (resourceInsert) or curators. Hidden when empty.
function FundingResourcesStrip() {
  const [items, setItems] = useState<Array<{ id: string; name: string; external_url: string | null; description: string | null }>>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await (supabase as unknown as {
        from: (t: string) => {
          select: (c: string) => { eq: (k: string, v: string) => { order: (c: string) => Promise<{ data: Array<{ id: string; name: string; external_url: string | null; description: string | null }> | null }> } };
        };
      })
        .from("resources")
        .select("id,name,external_url,description")
        .eq("resource_type", "funding")
        .order("name");
      if (!cancelled) setItems(data ?? []);
    })();
    return () => { cancelled = true; };
  }, []);
  if (!items.length) return null;
  return (
    <div className="mb-6 rounded-lg border border-border bg-card/50 p-4">
      <h2 className="mb-2 text-sm font-semibold text-foreground">Funding resources</h2>
      <ul className="flex flex-wrap gap-2">
        {items.map((r) => (
          <li key={r.id}>
            <a
              href={r.external_url ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-primary hover:underline"
              title={r.description ?? undefined}
            >
              {r.name}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function FundingOpportunities() {
  const [opportunities, setOpportunities] = useState<FundingOpportunity[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [selectedOpp, setSelectedOpp] = useState<FundingOpportunity | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const { isCurator } = useUserTier();

  const onRowClicked = useCallback((event: RowClickedEvent<FundingOpportunity>) => {
    if (event.data) {
      setSelectedOpp(event.data);
      setPanelOpen(true);
    }
  }, []);

  const fetchData = useCallback(async () => {
    setDataLoading(true);
    const { data, error } = await supabase
      .from("funding_opportunities")
      .select("*")
      .order("expiration_date", { ascending: true });
    if (!error && data) {
      setOpportunities(data as unknown as FundingOpportunity[]);
    }
    setDataLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        headerName: "Status",
        field: "status",
        width: 110,
        cellRenderer: StatusRenderer,
        filter: true,
      },
      {
        headerName: "FON",
        field: "fon",
        width: 150,
        filter: true,
        cellStyle: { fontWeight: 600, fontFamily: "monospace", fontSize: "12px" },
      },
      {
        headerName: "Activity",
        field: "activity_code",
        width: 90,
        filter: true,
        cellRenderer: ({ value }: { value: string | null }) =>
          value ? <Badge variant="secondary">{value}</Badge> : null,
      },
      {
        headerName: "Title",
        field: "title",
        minWidth: 300,
        flex: 1,
        filter: true,
        wrapText: true,
        autoHeight: true,
        cellStyle: { lineHeight: "1.4", paddingTop: "8px", paddingBottom: "8px" },
      },
      {
        headerName: "Due Dates",
        field: "due_dates",
        width: 200,
        cellRenderer: DueDatesRenderer,
        autoHeight: true,
      },
      {
        headerName: "Expires",
        field: "expiration_date",
        width: 120,
        valueFormatter: ({ value }) =>
          value ? format(parseISO(value), "MMM d, yyyy") : "—",
        sort: "asc",
      },
      {
        headerName: "Budget Ceiling",
        field: "budget_ceiling",
        width: 140,
        cellRenderer: BudgetRenderer,
      },
      {
        headerName: "NIH Institutes",
        field: "participating_orgs",
        width: 180,
        cellRenderer: TagsRenderer,
        autoHeight: true,
      },
      {
        headerName: "Tags",
        field: "relevance_tags",
        width: 220,
        cellRenderer: TagsRenderer,
        autoHeight: true,
      },
      {
        headerName: "Link",
        field: "url",
        width: 100,
        cellRenderer: LinkRenderer,
      },
    ],
    []
  );

  // Auth gate removed — preview mode auto-provides a user,
  // and production users are gated via sidebar navigation

  return (
    <div className="min-h-screen">
      <PageMeta
        title="Grants & Funding Opportunities | BBQS"
        description="Discover NIH funding opportunities relevant to BBQS consortium members."
      />

      <div className="max-w-[1600px] mx-auto px-4 py-8">
        <div className="mb-8">
          <div className="flex items-start justify-between gap-4 mb-2">
            <h1 className="text-3xl font-bold text-foreground">
              Grants & Funding Opportunities
            </h1>
            <div className="flex items-center gap-2">
              <Button asChild variant="outline">
                <a
                  href="https://www.thetransmitter.org/neuroscience-grants-funding-finder/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <BookOpen className="mr-2 h-4 w-4" />
                  Resources: Transmitter Funding Finder
                  <ExternalLink className="ml-2 h-3.5 w-3.5" />
                </a>
              </Button>
              {isCurator && (
              <AddFundingOpportunityDialog
                onCreated={fetchData}
                trigger={
                  <Button>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Opportunity
                  </Button>
                }
              />
              )}
            </div>
          </div>
          <p className="text-muted-foreground max-w-3xl">
            Active and upcoming NIH funding opportunities relevant to BBQS consortium members.
            Discover RFAs, PAs, and NOFOs that align with your research — filtered by activity code,
            institute, and deadline.
          </p>
          <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 max-w-2xl">
            <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-800 dark:text-amber-300">
              Deadlines highlighted in orange are due within 30 days. Always verify details on the
              official NIH NOFO page before applying.
            </p>
          </div>
        </div>

        <FundingResourcesStrip />

        <div
          className="ag-theme-alpine rounded-lg border border-border overflow-x-auto"
          style={{ width: "100%" }}
        >
          <AgGridReact
            rowData={opportunities}
            columnDefs={columnDefs}
            domLayout="autoHeight"
            animateRows
            suppressCellFocus
            loading={dataLoading}
            onRowClicked={onRowClicked}
            rowClass="cursor-pointer"
            defaultColDef={{
              sortable: true,
              resizable: true,
              unSortIcon: true,
            }}
          />
        </div>
      </div>

      <FundingDetailPanel
        opportunity={selectedOpp}
        open={panelOpen}
        onOpenChange={setPanelOpen}
      />
    </div>
  );
}
