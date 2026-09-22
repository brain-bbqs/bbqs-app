import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Download, ExternalLink, Search } from "lucide-react";
import {
  ALL_TYPES,
  BBQS_TYPES,
  SCHEMA_ROOTS,
  buildJsonLdExample,
  childrenOf,
  findType,
  type BbqsType,
} from "@/data/bbqs-schema";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useUserTier } from "@/hooks/useUserTier";

function TreeNode({
  node,
  selectedKey,
  onSelect,
  depth = 0,
  matcher,
}: {
  node: BbqsType;
  selectedKey: string;
  onSelect: (k: string) => void;
  depth?: number;
  matcher: (t: BbqsType) => boolean;
}) {
  const kids = childrenOf(node.key);
  const [open, setOpen] = useState(true);
  const isBbqs = node.key.startsWith("bbqs:");
  const matches = matcher(node);
  const anyKidMatches = kids.some((k) => matcher(k) || childrenOf(k.key).some(matcher));
  if (!matches && !anyKidMatches) return null;

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1 rounded px-1.5 py-1 text-sm cursor-pointer",
          selectedKey === node.key && "bg-primary/10 text-primary font-medium",
          !isBbqs && "text-muted-foreground italic",
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (isBbqs ? onSelect(node.key) : setOpen((o) => !o))}
      >
        {kids.length > 0 && (
          <ChevronRight
            className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
          />
        )}
        {kids.length === 0 && <span className="w-3" />}
        <span className="truncate">{node.label}</span>
      </div>
      {open &&
        kids.map((k) => (
          <TreeNode
            key={k.key}
            node={k}
            selectedKey={selectedKey}
            onSelect={onSelect}
            depth={depth + 1}
            matcher={matcher}
          />
        ))}
    </div>
  );
}

export default function BbqsSchema() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>("bbqs:FundedProject");
  const { isAdmin, isLoading: tierLoading } = useUserTier();

  const type = findType(selected)!;

  useEffect(() => {
    document.title = "BBQS Schema — types aligned to schema.org";
  }, []);

  const q = query.trim().toLowerCase();
  const matcher = useMemo(
    () => (t: BbqsType) => {
      if (!q) return true;
      return (
        t.label.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.properties.some((p) => p.name.toLowerCase().includes(q))
      );
    },
    [q],
  );

  const parentChain = useMemo(() => {
    const chain: BbqsType[] = [];
    let cur: BbqsType | undefined = type;
    while (cur?.parent) {
      const p = findType(cur.parent);
      if (!p) break;
      chain.unshift(p);
      cur = p;
    }
    return chain;
  }, [type]);

  // Internal while the KG schema migration is in progress: signed-in admins only.
  // (The route is also wrapped in ProtectedRoute, so the public never reaches this.)
  if (tierLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div className="flex h-screen items-center justify-center px-6 text-center text-sm text-muted-foreground">
        This page is internal and not yet published.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b bg-card">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="mb-6 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
            <strong>Internal — work in progress.</strong> This page is being migrated to the new BBQS
            knowledge-graph schema (OWL + SHACL consistency validation; master at{" "}
            <code className="font-mono">kg/bbqs.linkml.yaml</code>). It is admin-only and not yet
            public. The interactive tree below still reflects the previous schema.org-only model.
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">BBQS Schema</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">
            A canonical type hierarchy for the BBQS Consortium, aligned to{" "}
            <a
              href="https://schema.org"
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-1"
            >
              schema.org <ExternalLink className="h-3 w-3" />
            </a>
            . Every BBQS type either extends a schema.org class directly or specializes
            one for consortium-specific needs (e.g. NIH mechanism codes, device modalities).
            Consumers like BrainKB, MCP clients, and web crawlers can rely on this mapping
            to interpret BBQS records.
          </p>
          <div className="mt-4 flex gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{BBQS_TYPES.length} BBQS types</Badge>
            <Badge variant="secondary">{SCHEMA_ROOTS.length} schema.org anchors</Badge>
          </div>
          <div className="mt-4">
            <a
              href="/bbqs-schema.linkml.yaml"
              download
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:border-primary hover:text-primary"
            >
              <Download className="h-3.5 w-3.5" />
              Download LinkML (YAML)
            </a>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6 grid grid-cols-1 md:grid-cols-[280px_1fr] gap-6">
        {/* Left rail */}
        <aside className="border rounded-md bg-card p-3 h-fit md:sticky md:top-6">
          <div className="relative mb-3">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search types…"
              className="pl-7 h-8 text-sm"
            />
          </div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground px-1 pb-1">
            Hierarchy
          </div>
          {SCHEMA_ROOTS.filter((r) => r.key === "schema:Thing").map((root) => (
            <TreeNode
              key={root.key}
              node={root}
              selectedKey={selected}
              onSelect={setSelected}
              matcher={matcher}
            />
          ))}
        </aside>

        {/* Detail */}
        <section className="space-y-6">
          {/* Breadcrumb */}
          <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-1">
            {parentChain.map((p) => (
              <span key={p.key} className="flex items-center gap-1">
                <button className="hover:text-foreground" onClick={() => setSelected(p.key)}>
                  {p.label}
                </button>
                <ChevronRight className="h-3 w-3" />
              </span>
            ))}
            <span className="text-foreground font-medium">{type.label}</span>
          </div>

          <div>
            <h2 className="text-2xl font-semibold">{type.label}</h2>
            <p className="mt-2 text-muted-foreground">{type.description}</p>
            {type.subClassOf && (
              <p className="mt-3 text-sm">
                <span className="text-muted-foreground">subClassOf </span>
                <a
                  href={type.subClassOf}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  {type.subClassOf.replace("https://schema.org/", "schema:")}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            )}
          </div>

          {/* Children */}
          {childrenOf(type.key).length > 0 && (
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                More specific types
              </h3>
              <div className="flex flex-wrap gap-2">
                {childrenOf(type.key).map((c) => (
                  <button
                    key={c.key}
                    onClick={() => setSelected(c.key)}
                    className="rounded-full border px-3 py-1 text-sm hover:border-primary hover:text-primary"
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Properties */}
          {type.properties.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Properties
              </h3>
              <div className="overflow-x-auto border rounded-md">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Property</th>
                      <th className="px-3 py-2">Expected type</th>
                      <th className="px-3 py-2">schema.org</th>
                      <th className="px-3 py-2">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {type.properties.map((p) => (
                      <tr key={p.name} className="border-t">
                        <td className="px-3 py-2 font-mono text-xs">{p.name}</td>
                        <td className="px-3 py-2">{p.expectedType}</td>
                        <td className="px-3 py-2">
                          {p.schemaOrgEquivalent ? (
                            <a
                              href={p.schemaOrgEquivalent}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary hover:underline inline-flex items-center gap-1"
                            >
                              {p.schemaOrgEquivalent.replace("https://schema.org/", "")}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{p.note ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Instances */}
          {type.instancesFrom && type.instancesFrom.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Instances in BBQS
              </h3>
              <div className="flex flex-wrap gap-2">
                {type.instancesFrom.map((i) =>
                  i.path ? (
                    <Link
                      key={i.label}
                      to={i.path}
                      className="rounded border px-3 py-1 text-sm hover:border-primary hover:text-primary"
                    >
                      {i.label}
                    </Link>
                  ) : (
                    <span key={i.label} className="rounded border px-3 py-1 text-sm">
                      {i.label}
                    </span>
                  ),
                )}
              </div>
            </div>
          )}

          {/* Examples */}
          {type.examples && type.examples.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Examples
              </h3>
              <ul className="list-disc pl-5 text-sm space-y-1">
                {type.examples.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {/* JSON-LD */}
          {type.subClassOf && (
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Example JSON-LD
              </h3>
              <pre className="text-xs bg-muted/40 border rounded-md p-3 overflow-x-auto">
                {JSON.stringify(buildJsonLdExample(type), null, 2)}
              </pre>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}