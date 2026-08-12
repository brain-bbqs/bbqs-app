import { FolderOpen, Users, Bell, Gauge, DollarSign, FileText, Bug } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type WidgetKey =
  | "consortium_overview"
  | "my_projects"
  | "working_group_members"
  | "working_group_feed"
  | "funding_by_year"
  | "publications_trend"
  | "species_coverage";

export interface WidgetDef {
  key: WidgetKey;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Render across the full dashboard width. */
  wide?: boolean;
}

export const WIDGET_CATALOG: WidgetDef[] = [
  {
    key: "consortium_overview",
    title: "Consortium at a glance",
    description: "Headline counts of projects, people, publications, species and resources.",
    icon: Gauge,
    wide: true,
  },
  {
    key: "my_projects",
    title: "My projects & grants",
    description: "Grants linked to your investigator record, with quick edit access.",
    icon: FolderOpen,
  },
  {
    key: "working_group_members",
    title: "Working group members",
    description: "People who share a working group with you.",
    icon: Users,
  },
  {
    key: "working_group_feed",
    title: "Working group feed",
    description: "Latest consortium announcements for your groups.",
    icon: Bell,
  },
  {
    key: "funding_by_year",
    title: "Funding by fiscal year",
    description: "Total awarded across the consortium, by NIH fiscal year.",
    icon: DollarSign,
  },
  {
    key: "publications_trend",
    title: "Publications over time",
    description: "Consortium publication output for the last ten years.",
    icon: FileText,
  },
  {
    key: "species_coverage",
    title: "Species coverage",
    description: "Which taxonomic classes the consortium studies most.",
    icon: Bug,
  },
];

export interface WidgetSetting {
  key: WidgetKey;
  visible: boolean;
}

export const DEFAULT_WIDGETS: WidgetSetting[] = WIDGET_CATALOG.map((w) => ({
  key: w.key,
  visible: true,
}));

export function getWidgetDef(key: WidgetKey) {
  return WIDGET_CATALOG.find((w) => w.key === key);
}

/** Keep only known widget keys, then append any catalog widget that's missing. */
export function normalizeWidgets(raw: unknown): WidgetSetting[] {
  const known = new Set(WIDGET_CATALOG.map((w) => w.key));
  const list = Array.isArray(raw) ? raw : [];
  const cleaned: WidgetSetting[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const key = (item as WidgetSetting)?.key;
    if (typeof key === "string" && known.has(key as WidgetKey) && !seen.has(key)) {
      seen.add(key);
      cleaned.push({ key: key as WidgetKey, visible: (item as WidgetSetting).visible !== false });
    }
  }
  for (const w of WIDGET_CATALOG) {
    if (!seen.has(w.key)) cleaned.push({ key: w.key, visible: true });
  }
  return cleaned;
}