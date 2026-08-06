import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Search, BookOpen, Factory } from "lucide-react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import "@/styles/ag-grid-theme.css";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileCardList } from "@/components/MobileCardList";

type Category = {
  key: string;
  label: string;
  description: string | null;
  measures: string[] | null;
  typical_use_cases: string[] | null;
};

type Manufacturer = { id: string; name: string; homepage_url: string | null };

type Model = {
  id: string;
  model_name: string;
  device_class: string;
  product_url: string | null;
  manual_urls: string[] | null;
  output_signals: string[] | null;
  aliases: string[] | null;
  regulatory_class: string | null;
  sampling_rate_hz: number | null;
  manufacturer_id: string | null;
};

export function DeviceCatalog() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const isMobile = useIsMobile();

  useEffect(() => {
    (async () => {
      const [c, mf, m] = await Promise.all([
        supabase.from("device_categories" as any).select("key,label,description,measures,typical_use_cases").order("label"),
        supabase.from("device_manufacturers" as any).select("id,name,homepage_url").order("name"),
        supabase
          .from("device_models" as any)
          .select("id,model_name,device_class,product_url,manual_urls,output_signals,aliases,regulatory_class,sampling_rate_hz,manufacturer_id")
          .order("model_name"),
      ]);
      setCategories((c.data as any) || []);
      setManufacturers((mf.data as any) || []);
      setModels((m.data as any) || []);
      setLoading(false);
    })();
  }, []);

  const makerById = useMemo(
    () => Object.fromEntries(manufacturers.map((m) => [m.id, m])) as Record<string, Manufacturer>,
    [manufacturers]
  );

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of models) out[m.device_class] = (out[m.device_class] || 0) + 1;
    return out;
  }, [models]);

  const activeCategory = categories.find((c) => c.key === cat) || null;

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return models.filter((m) => {
      if (cat !== "all" && m.device_class !== cat) return false;
      if (!needle) return true;
      const maker = m.manufacturer_id ? makerById[m.manufacturer_id]?.name : "";
      const hay = [m.model_name, maker, m.device_class, ...(m.aliases || []), ...(m.output_signals || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [models, cat, q, makerById]);

  const labelFor = (key: string) => categories.find((c) => c.key === key)?.label || key.replace(/_/g, " ");

  const rows = useMemo(
    () =>
      visible.map((m) => ({
        ...m,
        manufacturer: m.manufacturer_id ? makerById[m.manufacturer_id]?.name || "—" : "—",
        manufacturer_url: m.manufacturer_id ? makerById[m.manufacturer_id]?.homepage_url : null,
        category: labelFor(m.device_class),
      })),
    [visible, makerById, categories]
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({ sortable: true, filter: true, resizable: true, flex: 1, minWidth: 110, wrapText: true, autoHeight: true }),
    []
  );

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        field: "model_name",
        headerName: "Device",
        minWidth: 200,
        flex: 1.6,
        cellRenderer: (p: any) =>
          p.data.product_url ? (
            <a
              href={p.data.product_url}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
            >
              {p.value}
              <ExternalLink className="h-3 w-3 opacity-60" />
            </a>
          ) : (
            <span className="font-medium">{p.value}</span>
          ),
      },
      {
        field: "manufacturer",
        headerName: "Manufacturer",
        minWidth: 150,
        cellRenderer: (p: any) =>
          p.data.manufacturer_url ? (
            <a href={p.data.manufacturer_url} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
              <Factory className="h-3 w-3" /> {p.value}
            </a>
          ) : (
            <span className="text-muted-foreground">{p.value}</span>
          ),
      },
      { field: "category", headerName: "Category", minWidth: 150 },
      {
        field: "output_signals",
        headerName: "Output signals",
        minWidth: 180,
        valueFormatter: (p: any) => (p.value || []).join(", "),
        cellRenderer: (p: any) =>
          p.value?.length ? (
            <div className="flex flex-wrap gap-1 py-1">
              {p.value.map((s: string) => (
                <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        field: "sampling_rate_hz",
        headerName: "Rate (Hz)",
        width: 110,
        flex: 0,
        valueFormatter: (p: any) => (p.value ? `${p.value}` : "—"),
      },
      {
        field: "regulatory_class",
        headerName: "Regulatory",
        minWidth: 120,
        valueFormatter: (p: any) => p.value || "—",
      },
      {
        field: "manual_urls",
        headerName: "Docs",
        width: 100,
        flex: 0,
        filter: false,
        sortable: false,
        cellRenderer: (p: any) =>
          p.value?.[0] ? (
            <a href={p.value[0]} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
              <BookOpen className="h-3 w-3" /> Manual
            </a>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
    ],
    []
  );

  return (
    <div>
      <div className="grid gap-3 md:grid-cols-3 mb-5">
        <Stat value={models.length} label="catalogued devices" />
        <Stat value={manufacturers.length} label="manufacturers" />
        <Stat value={categories.length} label="BBQS categories" />
      </div>

      <div className="relative mb-4 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a device, manufacturer, or signal…"
          className="w-full pl-9 pr-4 py-2 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        <Chip active={cat === "all"} onClick={() => setCat("all")} label={`All devices · ${models.length}`} />
        {categories.map((c) => (
          <Chip
            key={c.key}
            active={cat === c.key}
            muted={!counts[c.key]}
            onClick={() => setCat(c.key)}
            label={counts[c.key] ? `${c.label} · ${counts[c.key]}` : c.label}
          />
        ))}
      </div>

      {activeCategory && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 mb-5">
          <div className="text-sm font-semibold text-foreground">{activeCategory.label}</div>
          {activeCategory.description && (
            <p className="text-sm text-muted-foreground mt-1 max-w-3xl">{activeCategory.description}</p>
          )}
          <div className="flex flex-wrap gap-4 mt-3 text-xs">
            {!!activeCategory.measures?.length && (
              <div>
                <span className="uppercase tracking-wide text-muted-foreground">Measures</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {activeCategory.measures.map((s) => (
                    <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>
                  ))}
                </div>
              </div>
            )}
            {!!activeCategory.typical_use_cases?.length && (
              <div>
                <span className="uppercase tracking-wide text-muted-foreground">Typical use</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {activeCategory.typical_use_cases.map((s) => (
                    <Badge key={s} variant="outline" className="text-[10px]">{s}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading catalog…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No devices match that filter yet.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((m) => {
            const maker = m.manufacturer_id ? makerById[m.manufacturer_id] : undefined;
            return (
              <div key={m.id} className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-foreground leading-snug">{m.model_name}</div>
                    <div className="text-xs text-muted-foreground inline-flex items-center gap-1 mt-0.5">
                      <Factory className="h-3 w-3" />
                      {maker?.name || "Manufacturer unknown"}
                    </div>
                  </div>
                  <Badge variant="outline" className="text-[10px] border-primary/40 text-primary shrink-0">
                    {labelFor(m.device_class)}
                  </Badge>
                </div>

                {!!m.output_signals?.length && (
                  <div className="flex flex-wrap gap-1">
                    {m.output_signals.map((s) => (
                      <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  {m.sampling_rate_hz && <span>{m.sampling_rate_hz} Hz</span>}
                  {m.regulatory_class && <span>Regulatory: {m.regulatory_class}</span>}
                </div>

                <div className="flex flex-wrap gap-3 mt-auto pt-1 text-xs">
                  {m.product_url && (
                    <a href={m.product_url} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                      <ExternalLink className="h-3 w-3" /> Product page
                    </a>
                  )}
                  {m.manual_urls?.[0] && (
                    <a href={m.manual_urls[0]} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                      <BookOpen className="h-3 w-3" /> Manual
                    </a>
                  )}
                  {maker?.homepage_url && !m.product_url && (
                    <a href={maker.homepage_url} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                      <ExternalLink className="h-3 w-3" /> {maker.name}
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-2xl font-semibold text-foreground">{value}</div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function Chip({ label, active, muted, onClick }: { label: string; active: boolean; muted?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : muted
          ? "bg-muted/40 text-muted-foreground border-transparent hover:border-primary/40"
          : "bg-background text-foreground border-border hover:border-primary/50"
      }`}
    >
      {label}
    </button>
  );
}