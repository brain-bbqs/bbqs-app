// Single source of truth for the generic sandbox smoke suite.
// Adding a page/table/function to the QA sweep is one line here.

export const PUBLIC_ROUTES = [
  "/",
  "/about",
  "/projects",
  "/sfn-2025",
  "/mit-workshop-2026",
  "/mit-workshop-2026/participants",
  "/mit-workshop-2026/posters",
  "/working-groups",
  "/resources",
  "/resources/devices",
  "/announcements",
  "/roadmap",
  "/data-model",
  "/schema",
  "/auth",
  "/request-access",
  "/publications",
  "/investigators",
  "/data-sharing-policy",
  "/mcp-docs",
  "/mcp-tutorial",
  "/species",
  "/tutorials",
  "/data-provenance",
  "/suggest-feature",
  "/jobs",
  "/calendar",
  "/state-privacy",
  "/grants",
  "/cross-species-synchronization",
];

// Signed-out visits must redirect to /auth, not crash.
export const AUTH_ROUTES = [
  "/dashboard",
  "/settings",
  "/profile",
  "/admin",
  "/mit-workshop-2026/travel",
  "/mit-workshop-2026/speakers",
  "/mit-workshop-2026/menu",
  "/mit-workshop-2026/seating",
];

// Tables the site cannot work without. Cloned data means every one has rows.
export const CORE_TABLES = [
  "grants",
  "investigators",
  "publications",
  "resources",
  "species",
  "organizations",
  "announcements",
  "jobs",
  "grant_investigators",
  "funding_opportunities",
];

// Read-only / idempotent functions: safe to actually invoke.
export const SAFE_FUNCTIONS = [
  "analytics-summary",
  "bbqs-api",
  "nih-reporter-search",
  "state-privacy-scan",
  "suggest-related",
  "gap-analysis",
  "mit-workshop-participants",
  "mit-workshop-posters",
  "slack-channels",
];

// Anything with side effects gets a CORS preflight only — never invoked.
export const PREFLIGHT_ONLY_FUNCTIONS = [
  "globus-auth",
  "auth-notify",
  "send-welcome-email",
  "send-access-approved-email",
  "send-onboarding-reminder",
  "seed-all-tables",
  "seed-consortium",
  "seed-resources",
  "seed-staging-fakes",
  "sync-member-groups",
  "sync-author-orcids",
  "sync-publication-keywords",
  "harvest-grants-batch",
  "harvester-tick",
  "news-radar-poll",
  "budget-sync",
  "group-audit",
];
