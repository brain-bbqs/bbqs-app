// Deterministic blast-radius / complexity classifier for the issue→implementation pipeline.
//
// Constitution Principle II: the decision "is this safe to ship with a light gate" MUST be made by
// deterministic code reading the ACTUAL diff — never by the LLM judging its own change, and never
// from what an issue claims about itself. This file is that decision. It reads the changed-file set
// (path + line counts) and returns one of three classes:
//
//   A  trivial + low blast   → one-click approve to dev (Class-A gate)
//   B  normal app logic      → mandatory human review
//   C  touches a danger layer→ full Spec Kit + Constitution Check + human sign-off; never auto-merges
//
// The danger-layer list is not invented here: it is the set CLAUDE.md already names as "the shared
// layers that bite" — the ones where a small-looking diff has repo-wide reach and has broken prod
// before. Keeping the list HERE, mechanically, is the point: a prose warning cannot gate a merge.
//
// Pure + dependency-free so tests/guards can import classify() directly and the CI job can run it
// with plain `node`. No network, no git required to unit-test — git is only touched by the CLI.

/** Class-A ceilings. Above any of these a low-blast change is still B, not A: "small" is bounded, so
 *  a 1,200-line rewrite of one leaf component never slips through as trivial. */
export const THRESHOLDS = {
  maxFiles: 4, // distinct files changed
  maxLines: 80, // additions + deletions, summed across files
  maxNewFiles: 2, // brand-new files (a large new file is a feature, not a tweak)
};

/** first match wins per file. severity 'hard' → Class C; 'soft' → at least Class B.
 *  `why` is surfaced verbatim in the PR attribution comment, so it explains the reach to a human. */
export const DANGER_RULES = [
  // ── hard: repo-wide reach, or applied straight to production by hand ──────────────────────────
  {
    layer: "migration",
    severity: "hard",
    test: (p) => /^supabase\/migrations\//.test(p),
    why: "Schema/RLS/view migration — applied MANUALLY to production and hard to reverse. RLS policy and CREATE OR REPLACE VIEW changes live here too.",
  },
  {
    layer: "shared-edge-code",
    severity: "hard",
    test: (p) => /^supabase\/functions\/_shared\//.test(p),
    why: "Shared edge-function code (auth, CORS allow-list, grant-sync) — a change fans out to every function. A global header here once broke every function's CORS preflight (2026-08-07).",
  },
  {
    layer: "role-vocabulary",
    severity: "hard",
    test: (p) => /^supabase\/functions\/(group-audit|sync-member-groups)\/index\.ts$/.test(p),
    why: "Role-vocabulary surface (#283): drift here silently mis-computes Google Group membership. Guarded by role-vocabulary-parity.",
  },
  {
    layer: "auth",
    severity: "hard",
    test: (p) =>
      /^src\/pages\/(Auth|OAuthConsent)\.tsx$/.test(p) ||
      /^src\/integrations\/supabase\/(client|cookie-storage)\.ts$/.test(p),
    why: "Authentication / Supabase client config — gates every signed-in read and write across the app.",
  },
  {
    layer: "kg-schema-identifiers",
    severity: "hard",
    test: (p) => p === "public/bbqs-schema.linkml.yaml" || p === "src/data/bbqs-schema.ts",
    why: "LinkML identifiers / JSON-LD @id — name 29 classes and 42 slots; repointing them breaks stable identifiers (CLAUDE.md).",
  },
  {
    layer: "deploy-domain",
    severity: "hard",
    test: (p) => p === "public/CNAME",
    why: "Production domain (Pages CNAME) — a wrong value takes the live site offline.",
  },
  {
    layer: "ci-workflow",
    severity: "hard",
    test: (p) => /^\.github\/workflows\//.test(p) || /^\.github\/(scripts|sql)\//.test(p),
    why: "CI/CD workflow — this is the pipeline that ships everything else, including this gate.",
  },
  {
    layer: "triage-gate",
    severity: "hard",
    test: (p) => /^scripts\/triage\//.test(p) || /^tests\/guards\//.test(p),
    why: "The gate itself (classifier or guard suite). A change that could weaken the gate must never pass through the gate automatically.",
  },
  {
    layer: "dependency",
    severity: "hard",
    test: (p) => p === "package.json" || p === "bun.lock" || p === "package-lock.json",
    why: "Dependency/lockfile change — supply-chain surface; new dependencies are reviewed deliberately.",
  },
  {
    layer: "build-config",
    severity: "hard",
    test: (p) => /^(vite\.config\.[tj]s|tsconfig[^/]*\.json|tailwind\.config\.[tj]s|eslint\.config\.[tj]s|components\.json)$/.test(p),
    why: "Build/type/lint config — reaches the whole build output.",
  },

  // ── soft: real app logic, but scoped to one area (→ at least B, normal human review) ──────────
  {
    layer: "edge-function",
    severity: "soft",
    test: (p) => /^supabase\/functions\//.test(p),
    why: "Edge-function logic — server code that runs with elevated context; review its behavior and its CORS allow-list.",
  },
  {
    layer: "app-shell",
    severity: "soft",
    test: (p) => /^src\/(App|main)\.tsx$/.test(p) || p === "src/data/sidebar-config.ts",
    why: "App shell / routing / global nav — affects every page, not just one screen.",
  },
  {
    layer: "generated-types",
    severity: "soft",
    test: (p) => p === "src/integrations/supabase/types.ts",
    why: "Generated DB types — a change implies the schema moved underneath the app.",
  },
];

/** Paths that are genuinely low-blast: a Class-A change may ONLY touch these. Anything outside this
 *  allowlist that is not a danger layer is B (unknown reach = not trivial). */
const LOW_BLAST = [
  /^docs\//,
  /\.md$/,
  /^src\/pages\/[^/]+\.tsx$/, // a single leaf page (App.tsx/main.tsx are danger layers, matched first)
  /^src\/components\//,
  /^src\/.*\.css$/,
  /^public\//, // CNAME is a danger layer and is matched before we get here
];

function matchDanger(path) {
  for (const rule of DANGER_RULES) if (rule.test(path)) return rule;
  return null;
}

/**
 * @param {{path:string, additions?:number, deletions?:number}[]} files
 * @returns {{klass:'A'|'B'|'C', blast:{level:string,reasons:string[]}, complexity:{level:string,reasons:string[]}, danger:{path:string,layer:string,severity:string,why:string}[], totals:{files:number,lines:number,newFiles:number}}}
 */
export function classify(files) {
  const danger = [];
  let hard = false;
  let soft = false;
  let outsideLowBlast = false;

  for (const f of files) {
    const hit = matchDanger(f.path);
    if (hit) {
      danger.push({ path: f.path, layer: hit.layer, severity: hit.severity, why: hit.why });
      if (hit.severity === "hard") hard = true;
      else soft = true;
      continue;
    }
    if (!LOW_BLAST.some((re) => re.test(f.path))) outsideLowBlast = true;
  }

  const totals = {
    files: files.length,
    lines: files.reduce((n, f) => n + (f.additions || 0) + (f.deletions || 0), 0),
    newFiles: files.filter((f) => f.status === "added").length,
  };

  const blastReasons = [];
  let blastLevel;
  if (hard) {
    blastLevel = "high";
    blastReasons.push(...uniqueLayers(danger, "hard"));
  } else if (soft) {
    blastLevel = "medium";
    blastReasons.push(...uniqueLayers(danger, "soft"));
  } else if (outsideLowBlast) {
    blastLevel = "medium";
    blastReasons.push("Touches paths whose reach the classifier does not recognize as low-blast; reviewed as normal.");
  } else {
    blastLevel = "low";
    blastReasons.push("Only docs / leaf components / static assets — no shared layer.");
  }

  const complexityReasons = [];
  const overFiles = totals.files > THRESHOLDS.maxFiles;
  const overLines = totals.lines > THRESHOLDS.maxLines;
  const overNew = totals.newFiles > THRESHOLDS.maxNewFiles;
  if (overFiles) complexityReasons.push(`${totals.files} files changed (> ${THRESHOLDS.maxFiles}).`);
  if (overLines) complexityReasons.push(`${totals.lines} lines changed (> ${THRESHOLDS.maxLines}).`);
  if (overNew) complexityReasons.push(`${totals.newFiles} new files (> ${THRESHOLDS.maxNewFiles}).`);
  const complexityLevel = overFiles || overLines || overNew ? "high" : "low";
  if (complexityLevel === "low") complexityReasons.push(`${totals.files} files, ${totals.lines} lines — within Class-A limits.`);

  let klass;
  if (blastLevel === "high") klass = "C";
  else if (blastLevel === "medium") klass = "B";
  else klass = complexityLevel === "low" ? "A" : "B";

  return {
    klass,
    blast: { level: blastLevel, reasons: blastReasons },
    complexity: { level: complexityLevel, reasons: complexityReasons },
    danger,
    totals,
  };
}

function uniqueLayers(danger, severity) {
  const seen = new Set();
  const out = [];
  for (const d of danger) {
    if (d.severity !== severity) continue;
    if (seen.has(d.layer)) continue;
    seen.add(d.layer);
    out.push(`${d.layer}: ${d.why}`);
  }
  return out;
}

const CLASS_LABEL = { A: "auto:A", B: "review:B", C: "spec:C" };
const CLASS_GATE = {
  A: "Trivial + low blast radius. Eligible for one-click approve → merge to `dev` once all checks are green.",
  B: "Normal change. Requires a human review before it can merge to `dev`.",
  C: "Touches a danger layer. Requires Spec Kit artifacts (spec/plan/tasks/qa-itinerary), a Constitution Check, and human sign-off. Never auto-merges.",
};

/** Markdown for the PR attribution comment — this IS the blast-radius attribution the maintainer reads. */
export function formatSummary(result) {
  const lines = [];
  lines.push(`### 🤖 Triage: Class ${result.klass} → \`${CLASS_LABEL[result.klass]}\``);
  lines.push("");
  lines.push(CLASS_GATE[result.klass]);
  lines.push("");
  lines.push(`**Blast radius: ${result.blast.level.toUpperCase()}**`);
  for (const r of result.blast.reasons) lines.push(`- ${r}`);
  lines.push("");
  lines.push(`**Complexity: ${result.complexity.level.toUpperCase()}**`);
  for (const r of result.complexity.reasons) lines.push(`- ${r}`);
  if (result.danger.length) {
    lines.push("");
    lines.push("**Files that set the class:**");
    for (const d of result.danger) lines.push(`- \`${d.path}\` → ${d.layer} (${d.severity})`);
  }
  lines.push("");
  lines.push("<sub>Deterministic classifier — computed from the diff, not from the issue text. Change the rules in `scripts/triage/classify.mjs` (itself a Class-C path).</sub>");
  return lines.join("\n");
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────
// Usage:
//   node scripts/triage/classify.mjs --numstat <file>   # parse `git diff --numstat` output
//   node scripts/triage/classify.mjs --base <sha> --head <sha>
//   node scripts/triage/classify.mjs                     # uses env BASE_SHA / HEAD_SHA
// Writes classification.json (--out to override) and prints the markdown summary to stdout.
async function main(argv) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");

  const args = parseArgs(argv);
  let numstat;
  if (args.numstat) {
    numstat = readFileSync(args.numstat, "utf8");
  } else {
    const base = args.base || process.env.BASE_SHA;
    const head = args.head || process.env.HEAD_SHA || "HEAD";
    const range = base ? `${base}...${head}` : head;
    numstat = execFileSync("git", ["diff", "--numstat", range], { encoding: "utf8" });
  }

  const files = parseNumstat(numstat);
  const result = classify(files);
  const summary = formatSummary(result);

  const out = args.out || "classification.json";
  writeFileSync(out, JSON.stringify({ ...result, summary }, null, 2));
  process.stdout.write(summary + "\n");
  // Class as the process's machine-readable channel for the workflow (exit 0 always; the class is data, not pass/fail).
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `class=${result.klass}\nlabel=${CLASS_LABEL[result.klass]}\n`, { flag: "a" });
  }
}

/** `git diff --numstat` → [{path, additions, deletions, status}]. A binary file shows "-\t-\t<path>". */
export function parseNumstat(text) {
  const files = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    let path = m[3];
    // Rename form: "old => new" or "dir/{old => new}/x". Take the destination path.
    if (path.includes("=>")) path = path.replace(/\{[^}]*=>\s*([^}]*)\}/g, "$1").replace(/.*=>\s*/, "").trim();
    const additions = m[1] === "-" ? 0 : Number(m[1]);
    const deletions = m[2] === "-" ? 0 : Number(m[2]);
    files.push({ path, additions, deletions, status: deletions === 0 && additions > 0 ? "added" : "modified" });
  }
  return files;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--numstat") args.numstat = argv[++i];
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--head") args.head = argv[++i];
    else if (a === "--out") args.out = argv[++i];
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
