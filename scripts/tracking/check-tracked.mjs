#!/usr/bin/env node
// Every non-trivial change traces to an issue (rules in tracking.mjs). Two modes:
//
//   pr    the `tracked` check. Passes when the PR (title, body or any commit) references an issue,
//         is labelled `trivial` / tagged [trivial], is small once generated files are left out, or is
//         a dev -> main release (everything in it was checked on its way into dev).
//   push  for commits that reached a branch WITHOUT a PR: any that reference no issue and are not
//         trivial are listed in an open "Untracked work on <branch>" issue (created if needed), which
//         lands on the project board and in the progress report until someone attaches the work.
//
// DRY_RUN=1 reports what push mode would file without writing anything.
import { execFileSync } from "node:child_process";
import { referencesIssue, markedTrivial, size, isTiny, TINY } from "./tracking.mjs";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const env = process.env;
const ZERO = /^0+$/;

function pr() {
  const labels = (env.PR_LABELS || "").split(",").map(s => s.trim().toLowerCase());
  const head = `${env.PR_TITLE || ""}\n${env.PR_BODY || ""}`;
  const commits = git("log", "--format=%B%x00", `${env.BASE_SHA}..${env.HEAD_SHA}`);
  const s = size(git("diff", "--numstat", `${env.BASE_SHA}...${env.HEAD_SHA}`));
  const why = env.PR_BASE_REF === "main" && env.PR_HEAD_REF === "dev" ? "a release of dev, whose changes were checked on their way in"
    : labels.includes("trivial") || markedTrivial(env.PR_TITLE) ? "marked trivial"
    : referencesIssue(head) ? "the PR references an issue"
    : referencesIssue(commits) ? "a commit references an issue"
    : isTiny(s) ? `small (${s.lines} lines in ${s.files} files)` : null;
  if (why) { console.log(`tracked: ${why}.`); return 0; }
  console.log(`::error::This change (${s.lines} lines in ${s.files} files, generated files aside) names no issue.`);
  console.log(`Add "Refs #<issue>" (or Closes / Part of #<issue>) to the PR description, or label it "trivial" if it is.`);
  console.log(`Small changes (up to ${TINY.lines} lines in ${TINY.files} files) pass without one.`);
  return 1;
}

async function api(path, init = {}) {
  const r = await fetch(`https://api.github.com/repos/${env.REPO}/${path}`, {
    ...init, headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
                        "Content-Type": "application/json", ...(init.headers || {}) } });
  if (!r.ok && r.status !== 422) throw new Error(`${init.method || "GET"} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function push() {
  if (ZERO.test(env.AFTER || "")) return 0;                                   // branch deleted
  const range = ZERO.test(env.BEFORE || "")
    ? [env.AFTER, "--not", ...git("branch", "-r", "--format=%(refname:short)").split("\n")
        .filter(b => /^origin\/(dev|main)$/.test(b))]
    : [`${env.BEFORE}..${env.AFTER}`];
  const shas = git("rev-list", "--max-count=200", ...range).split("\n").filter(Boolean).reverse();
  const untracked = [];
  for (const sha of shas) {
    if (git("rev-list", "--parents", "-n1", sha).split(" ").length > 2) continue;   // merge commit
    const msg = git("log", "-1", "--format=%B", sha);
    const author = git("log", "-1", "--format=%an", sha);
    if (/\[bot\]$/.test(author) || referencesIssue(msg) || markedTrivial(msg)) continue;
    const s = size(git("show", "--numstat", "--format=", sha));
    if (isTiny(s)) continue;
    const prs = await api(`commits/${sha}/pulls`);
    if (Array.isArray(prs) && prs.length) continue;                              // checked as a PR
    untracked.push({ sha, author, subject: msg.split("\n")[0], ...s });
  }
  if (!untracked.length) { console.log(`push to ${env.BRANCH}: every non-trivial commit is tracked.`); return 0; }

  const rows = untracked.map(c => `| \`${c.sha.slice(0, 8)}\` | ${c.author} | ${c.subject.replace(/\|/g, "\\|")} | ${c.lines} lines, ${c.files} files |`);
  const table = ["| Commit | Author | Change | Size |", "|---|---|---|---|", ...rows].join("\n");
  const title = `Untracked work on ${env.BRANCH}`;
  console.log(`${untracked.length} untracked commit(s) on ${env.BRANCH}:\n${table}`);
  if (env.DRY_RUN) return 0;

  await api("labels", { method: "POST", body: JSON.stringify({ name: "untracked", color: "D93F0B",
    description: "Commits that reached a branch without an issue; attach them to one, then close this" }) });
  const open = await api(`issues?state=open&labels=untracked&per_page=100`);
  const existing = (open || []).find(i => i.title === title);
  if (existing) {
    await api(`issues/${existing.number}/comments`, { method: "POST", body: JSON.stringify({ body: `More untracked commits:\n\n${table}` }) });
    console.log(`appended to #${existing.number}`);
  } else {
    const body = `These commits reached \`${env.BRANCH}\` without a pull request, name no issue, and are larger than a trivial change `
      + `(${TINY.lines} lines in ${TINY.files} files, generated files aside).\n\n${table}\n\n`
      + `Attach each to the issue it belongs to (or open one), so the work shows on the project board and in the progress report. Then close this issue. `
      + `Next time, put "Refs #<issue>" in the commit message, or tag a genuinely small change [trivial].`;
    const made = await api("issues", { method: "POST", body: JSON.stringify({ title, body, labels: ["untracked"] }) });
    console.log(`opened #${made.number}`);
  }
  return 0;
}

const mode = process.argv[2];
process.exitCode = mode === "pr" ? pr() : mode === "push" ? await push() : (console.error("usage: check-tracked.mjs pr|push"), 2);
