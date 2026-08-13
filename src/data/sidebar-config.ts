import {
  Home,
  FolderOpen,
  Calendar,
  Users,
  BookOpen,
  Bell,
  Map,
  Briefcase,
  CalendarDays,
  Info,
  FileText,
  Scale,
  Shield,
  Package,
  Globe,
  Database,
  Bug,
  History,
  Lightbulb,
  Bot,
  FlaskConical,
  Hotel,
  ShieldCheck,
  ScrollText,
  Plane,
  Mic,
  ChefHat,
  LayoutGrid,
  Presentation,
  LayoutDashboard,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
  disabled?: boolean;
  authRequired?: boolean;
  adminOnly?: boolean;
  external?: boolean;
  children?: NavItem[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

const mainItems: NavItem[] = [
  { title: "Home", url: "/", icon: Home },
  { title: "About", url: "/about", icon: Info },
  { title: "Settings", url: "/settings", icon: Settings, authRequired: true },
  { title: "BBQS Agent", url: "https://agent.brain-bbqs.org", icon: Bot, external: true },
  { title: "My Dashboard", url: "/dashboard", icon: LayoutDashboard, authRequired: true },
  { title: "Suggest a Feature", url: "/suggest-feature", icon: Lightbulb },
];

const toolsItems: NavItem[] = [
  { title: "Resources", url: "/resources", icon: Database },
  { title: "Devices", url: "/resources/devices", icon: FlaskConical },
];

const knowledgeBaseItems: NavItem[] = [
  { title: "Projects", url: "/projects", icon: FolderOpen },
  { title: "Funding Calls", url: "/grants", icon: Globe },
  { title: "Species", url: "/species", icon: Bug },
  { title: "Publications", url: "/publications", icon: FileText },
  { title: "Data Provenance", url: "/data-provenance", icon: History, disabled: true },
];

const communityItems: NavItem[] = [
  { title: "People", url: "/investigators", icon: Users },
  { title: "Working Groups", url: "/working-groups", icon: Users },
  { title: "Announcements", url: "/announcements", icon: Bell },
  { title: "Job Board", url: "/jobs", icon: Briefcase },
  { title: "Calendar", url: "/calendar", icon: CalendarDays, authRequired: true },
];

const conferencesItems: NavItem[] = [
  {
    title: "MIT Workshop 2026",
    url: "/mit-workshop-2026",
    icon: Calendar,
    children: [
      { title: "Travel & Hotel", url: "/mit-workshop-2026/travel", icon: Plane, authRequired: true },
      { title: "Participants", url: "/mit-workshop-2026/participants", icon: Users, authRequired: true },
      { title: "Speakers & Talks", url: "/mit-workshop-2026/speakers", icon: Mic, authRequired: true },
      { title: "Menu", url: "/mit-workshop-2026/menu", icon: ChefHat, authRequired: true },
      { title: "Seating Chart", url: "/mit-workshop-2026/seating", icon: LayoutGrid, authRequired: true },
      { title: "Poster Sessions", url: "/mit-workshop-2026/posters", icon: Presentation, authRequired: true },
    ],
  },
  { title: "SFN 2025", url: "/sfn-2025", icon: Calendar },
];

const engineeringItems: NavItem[] = [
  { title: "Roadmap", url: "/roadmap", icon: Map },
  { title: "Data Model", url: "/data-model", icon: Database },
  { title: "BBQS Schema", url: "/schema", icon: Database },
  { title: "Suggest a Feature", url: "/suggest-feature", icon: Lightbulb },
  { title: "Admin Console", url: "/admin", icon: ShieldCheck, adminOnly: true },
];

const legalItems: NavItem[] = [
  { title: "Data Sharing Policy", url: "/data-sharing-policy", icon: Scale },
];

export const sidebarGroups: NavGroup[] = [
  { label: "Main", items: mainItems },
  { label: "Community", items: communityItems },
  { label: "Tools", items: toolsItems },
  { label: "Knowledge Base", items: knowledgeBaseItems },
  { label: "Conferences", items: conferencesItems },
  { label: "Engineering", items: engineeringItems },
  { label: "Legal", items: legalItems },
];
