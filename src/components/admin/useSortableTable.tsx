import { useMemo, useState } from "react";
import { TableHead } from "@/components/ui/table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

/** Sortable table columns, shared by the admin console tables.
 *
 *  One primitive rather than per-table sort state, because the console has several tables and they
 *  should behave identically — and because the useful question is usually "show me all the PIs
 *  together", which is sorting by a column, not a bespoke filter per screen.
 *
 *  Comparison rules that matter for this data:
 *  - NULL and empty sort LAST in both directions. `investigators.role` is NULL for 68 people, and
 *    burying them at the bottom is right whichever way you sort — an absent value is not "before A".
 *  - Numbers compare numerically, dates as dates, everything else case-insensitively and
 *    locale-aware, so "Ávila" files next to "Avila" rather than after "Z".
 *  - Sorting is STABLE: equal rows keep their previous order, so clicking Role then Member gives
 *    role-major, name-minor rather than an arbitrary shuffle.
 */
export type SortDir = "asc" | "desc";

export function useSortableTable<T>(rows: T[], initialKey?: string, initialDir: SortDir = "asc") {
  const [sortKey, setSortKey] = useState<string | undefined>(initialKey);
  const [sortDir, setSortDir] = useState<SortDir>(initialDir);
  /** key -> how to extract the comparable value for a row. */
  const [accessors] = useState(() => new Map<string, (row: T) => unknown>());

  const register = (key: string, accessor: (row: T) => unknown) => {
    accessors.set(key, accessor);
  };

  const toggle = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  const isEmpty = (v: unknown) =>
    v === null || v === undefined || (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const get = accessors.get(sortKey);
    if (!get) return rows;
    const dir = sortDir === "asc" ? 1 : -1;
    // Decorate with the original index so the sort is stable across clicks.
    return rows
      .map((row, i) => ({ row, i, v: get(row) }))
      .sort((a, b) => {
        const ae = isEmpty(a.v), be = isEmpty(b.v);
        if (ae && be) return a.i - b.i;
        if (ae) return 1;              // empties last regardless of direction
        if (be) return -1;
        let c: number;
        if (typeof a.v === "number" && typeof b.v === "number") c = a.v - b.v;
        else if (typeof a.v === "boolean" && typeof b.v === "boolean") c = (a.v ? 1 : 0) - (b.v ? 1 : 0);
        else if (a.v instanceof Date && b.v instanceof Date) c = a.v.getTime() - b.v.getTime();
        else c = String(a.v).localeCompare(String(b.v), undefined, { sensitivity: "base", numeric: true });
        return c !== 0 ? c * dir : a.i - b.i;
      })
      .map((d) => d.row);
  }, [rows, sortKey, sortDir, accessors]);

  /** A <TableHead> that sorts. `accessor` says what to compare; omit it for a non-sortable column. */
  const SortableHead = ({
    columnKey, accessor, children, className,
  }: {
    columnKey: string;
    accessor: (row: T) => unknown;
    children: React.ReactNode;
    className?: string;
  }) => {
    register(columnKey, accessor);
    const active = sortKey === columnKey;
    const Icon = !active ? ChevronsUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
    return (
      <TableHead className={className}>
        <button
          type="button"
          onClick={() => toggle(columnKey)}
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
          aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
          title={`Sort by ${typeof children === "string" ? children : columnKey}`}
        >
          {children}
          <Icon className={`h-3 w-3 ${active ? "text-foreground" : "text-muted-foreground/50"}`} />
        </button>
      </TableHead>
    );
  };

  return { sorted, sortKey, sortDir, SortableHead };
}
