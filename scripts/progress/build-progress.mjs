#!/usr/bin/env node
// Build the BBQS progress report from the org project board: phases -> milestones -> work.
//
//   GH_TOKEN=<token that can read org projects> node scripts/progress/build-progress.mjs \
//     [--out-dir DIR] [--quality kg/export/quality.json] [--roundtrip kg/export/roundtrip.json]
//
// Writes progress.json (the data every report is made from; the site's /progress page reads it)
// and progress.md (the weekly digest). The board is the source of
// truth: a phase is an issue labelled "roadmap: phase", a milestone one labelled "roadmap: milestone"
// whose parent is its phase, and the work is the milestone's sub-issues. Nothing here is hand-kept.
// The built-in GITHUB_TOKEN cannot read org projects; pass a token with Projects: read.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ORG = "brain-bbqs";
const PROJECT = 6;
const KG_PHASE = 386;
// Which measured number tells each KG v1 milestone's state (from the quality and round-trip reports),
// so these milestones report themselves instead of relying on a hand-written status line.
const KG_MEASURES = { 450: ["errors"], 451: ["carried", "unconnected"], 452: ["questions"] };
const REPOS = ["bbqs-app", "bbqs-agent"];
const PHASE = "roadmap: phase";
const MILESTONE = "roadmap: milestone";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc, []));
const outDir = args["out-dir"] || ".";
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) { console.error("Set GH_TOKEN to a token that can read org projects."); process.exit(2); }

async function gql(query, variables) {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "GraphQL-Features": "sub_issues,issue_types" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map(e => e.message).join("; "));
  return j.data;
}

const ITEMS = `query($org:String!,$num:Int!,$after:String){organization(login:$org){projectV2(number:$num){
  title url public
  items(first:100, after:$after){ pageInfo{hasNextPage endCursor} nodes{
    status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }
    doneWhen: fieldValueByName(name:"Done when"){ ... on ProjectV2ItemFieldTextValue{ text } }
    content{ __typename ... on Issue{
      number title state url closedAt body
      repository{ nameWithOwner }
      labels(first:20){ nodes{ name } }
      parent{ number repository{ nameWithOwner } }
      subIssuesSummary{ total completed percentCompleted }
      issueFieldValues(first:10){ nodes{ ... on IssueFieldDateValue{ value field{ ... on IssueFieldDate{ name } } } } }
    } }
  } } } } }`;

// Phases and milestones come from their labels, repo by repo: the board's item listing can lag
// newly added issues for a while, an issue's own label and project fields do not.
const ROADMAP = `query($owner:String!,$repo:String!,$labels:[String!],$after:String){repository(owner:$owner,name:$repo){
  issues(first:100, after:$after, labels:$labels, states:[OPEN,CLOSED]){ pageInfo{hasNextPage endCursor} nodes{
    number title state url closedAt body
    repository{ nameWithOwner }
    labels(first:20){ nodes{ name } }
    parent{ number repository{ nameWithOwner } }
    subIssuesSummary{ total completed percentCompleted }
    issueFieldValues(first:10){ nodes{ ... on IssueFieldDateValue{ value field{ ... on IssueFieldDate{ name } } } } }
    projectItems(first:10){ nodes{ project{ number }
      status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }
      doneWhen: fieldValueByName(name:"Done when"){ ... on ProjectV2ItemFieldTextValue{ text } } } }
  } } } }`;

async function roadmapIssues() {
  const out = [];
  for (const repo of REPOS) {
    let after = null;
    do {
      const d = await gql(ROADMAP, { owner: ORG, repo, labels: [PHASE, MILESTONE], after });
      const conn = d.repository.issues;
      for (const c of conn.nodes) {
        const pi = c.projectItems.nodes.find(n => n.project.number === PROJECT) || {};
        out.push({ status: pi.status, doneWhen: pi.doneWhen, content: c });
      }
      after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (after);
  }
  return out;
}

async function boardItems() {
  const out = []; let after = null, project = null;
  do {
    const d = await gql(ITEMS, { org: ORG, num: PROJECT, after });
    const p = d.organization.projectV2;
    project = { title: p.title, url: p.url, public: p.public };
    for (const n of p.items.nodes) if (n.content?.__typename === "Issue") out.push(n);
    after = p.items.pageInfo.hasNextPage ? p.items.pageInfo.endCursor : null;
  } while (after);
  return { project, items: out };
}

// "**Where it stands.** ..." -> the paragraph after the marker, as plain text: readers see no markdown.
const plain = t => t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
const section = (body, name) => {
  const m = (body || "").match(new RegExp(`\\*\\*${name}\\.?\\*\\*\\s*([\\s\\S]*?)(?:\\n\\s*\\n|$)`));
  return m ? plain(m[1].trim()) : null;
};
const dates = c => Object.fromEntries((c.issueFieldValues?.nodes || []).filter(v => v?.value)
  .map(v => [v.field.name === "Start date" ? "start" : v.field.name === "Target date" ? "target" : v.field.name, v.value]));
const key = c => `${c.repository.nameWithOwner}#${c.number}`;
const labelled = (c, l) => c.labels.nodes.some(x => x.name === l);

function status(item, c) {
  if (c.state === "CLOSED") return "Done";
  const s = c.subIssuesSummary;
  if (s?.completed > 0 && s.completed < s.total) return "In progress";
  return item.status?.name || "Todo";
}

function node(item) {
  const c = item.content, s = c.subIssuesSummary || { total: 0, completed: 0, percentCompleted: 0 };
  return {
    number: c.number, repo: c.repository.nameWithOwner, url: c.url,
    title: c.title.replace(/^KG v\d+ · \d+\.\s*/, ""),      // milestones carry their phase in the title for the board
    status: status(item, c), ...dates(c),
    done_when: item.doneWhen?.text || section(c.body, "Done when"),
    what: section(c.body, "What it is") || section(c.body, "Outcome"),
    now: section(c.body, "Where it stands"),
    progress: { completed: s.completed, total: s.total, percent: s.percentCompleted },
    closed_at: c.closedAt,
  };
}

function kgMeasures() {
  const read = p => p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  const q = read(args.quality), rt = read(args.roundtrip);
  const m = {};
  if (rt?.pct != null) m.carried = { label: "Database facts carried in the graph", value: `${rt.pct}%`, goal: "95% or more" };
  if (q?.structure) {
    const pct = Math.round(100 * q.structure.isolated / q.structure.nodes);
    m.unconnected = { label: "Records not connected to anything", value: `${pct}%`, goal: "under 10%" };
  }
  if (q?.competency) {
    const a = q.competency.filter(x => x.status === "answered").length;
    m.questions = { label: "Standard questions the graph answers", value: `${a} of ${q.competency.length}`, goal: `15 of ${q.competency.length}` };
  }
  if (q?.violation_count != null) m.errors = { label: "Consistency errors", value: String(q.violation_count), goal: "0" };
  return m;
}

const rank = { "In progress": 0, Todo: 1, Done: 2 };
const phaseOrder = (a, b) => (/\(later\)/i.test(a.title) - /\(later\)/i.test(b.title))
  || (rank[a.status] ?? 1) - (rank[b.status] ?? 1)
  || (a.target || "9999").localeCompare(b.target || "9999") || a.number - b.number;

const { project, items } = await boardItems();
const roadmap = await roadmapIssues();
const phases = roadmap.filter(i => labelled(i.content, PHASE)).map(i => ({ ...node(i), milestones: [] }));
const phaseByKey = new Map(phases.map(p => [`${p.repo}#${p.number}`, p]));
for (const i of roadmap.filter(i => labelled(i.content, MILESTONE))) {
  const par = i.content.parent && `${i.content.parent.repository.nameWithOwner}#${i.content.parent.number}`;
  phaseByKey.get(par)?.milestones.push(node(i));
}
for (const p of phases) {
  p.milestones.sort((a, b) => a.number - b.number);
  if (p.number === KG_PHASE) {
    const kg = kgMeasures();
    p.measures = Object.values(kg);
    for (const m of p.milestones) {
      const got = (KG_MEASURES[m.number] || []).map(k => kg[k]).filter(Boolean);
      if (got.length) { m.measures = got; m.now = null; }      // measured beats hand-written
    }
  }
}
phases.sort(phaseOrder);

// Open work with no place on the roadmap: no parent at all, and not itself a phase or milestone.
const notOnRoadmap = items.map(i => i.content)
  .filter(c => c.state === "OPEN" && !c.parent && !labelled(c, PHASE) && !labelled(c, MILESTONE))
  .map(c => ({ number: c.number, repo: c.repository.nameWithOwner, title: c.title, url: c.url,
               untracked: labelled(c, "untracked") }));

const report = {
  generated_at: new Date().toISOString(), project, phases,
  not_on_roadmap: notOnRoadmap,
  milestones: { total: phases.reduce((n, p) => n + p.milestones.length, 0),
                done: phases.reduce((n, p) => n + p.milestones.filter(m => m.status === "Done").length, 0) },
};

const day = s => s ? new Date(s + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null;
const md = [];
md.push(`# BBQS progress · ${new Date().toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" })}`, "");
md.push(`${report.milestones.done} of ${report.milestones.total} milestones done across ${phases.length} phases.`, "");
for (const p of phases) {
  md.push(`## ${p.title} · ${p.status}${p.target ? ` · target ${day(p.target)}` : ""}`);
  if (p.what) md.push("", p.what);
  for (const m of p.milestones) {
    const mark = m.status === "Done" ? "✅" : m.status === "In progress" ? "🔵" : "⚪";
    md.push("", `- ${mark} **${m.title}**${m.target ? ` (target ${day(m.target)})` : ""}`);
    if (m.done_when) md.push(`  - Done when: ${m.done_when}`);
    if (m.measures && m.status !== "Done") md.push(`  - Now: ${m.measures.map(x => `${x.label.toLowerCase()} ${x.value} (goal ${x.goal})`).join("; ")}`);
    else if (m.now && m.status !== "Done") md.push(`  - Now: ${m.now}`);
    if (m.progress.total) md.push(`  - Work: ${m.progress.completed} of ${m.progress.total} done`);
  }
  if (p.measures?.length) {
    md.push("", "Measures:");
    for (const x of p.measures) md.push(`- ${x.label}: **${x.value}** (goal: ${x.goal})`);
  }
  md.push("");
}
if (notOnRoadmap.length) {
  md.push(`## Not yet on the roadmap (${notOnRoadmap.length})`, "", "Open issues with no milestone or phase. Attach each to one, or close it.", "");
  for (const o of notOnRoadmap) md.push(`- [${o.repo.split("/")[1]}#${o.number}](${o.url}) ${o.title}${o.untracked ? " *(untracked work)*" : ""}`);
  md.push("");
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "progress.json"), JSON.stringify(report, null, 1));
writeFileSync(join(outDir, "progress.md"), md.join("\n"));
console.log(`${phases.length} phases, ${report.milestones.total} milestones (${report.milestones.done} done), `
  + `${notOnRoadmap.length} open issues not on the roadmap -> ${join(outDir, "progress.json")}`);
