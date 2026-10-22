#!/usr/bin/env node
// Moves the issues a change names on the org project board, so the board follows the work instead
// of waiting for someone to drag cards. The `tracked` check only proves a change names its issue;
// without this, an issue sat at Todo from the day it was filed until someone closed it by hand.
//
//   pr    a PR into dev or main: every open issue it names (title, body, commits) -> In progress
//   push  a push to dev or main: every open issue its commits name, and the bodies of the PRs it
//         merged -> In progress. An issue not yet on the board is added first.
//
// Done is GitHub's job: a "Closes #N" commit closes #N when it reaches main, and the board's own
// "Item closed" workflow marks it Done. Nothing here moves an issue backwards or touches a closed one.
// Rules in tracking.mjs (issueRefs, nextStatus), guarded by tests/guards/work-tracking.test.mjs.
//
// Needs PROJECT_WRITE_TOKEN (Projects: read and write, Issues: read): GITHUB_TOKEN cannot write to an
// org project. Without it this reports what it would do and exits 0. DRY_RUN=1 does the same.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { issueRefs, nextStatus } from "./tracking.mjs";

const env = process.env;
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const ZERO = /^0+$/;
const OWNER = env.PROJECT_OWNER || "brain-bbqs";
const NUMBER = Number(env.PROJECT_NUMBER || 6);
const WRITE = Boolean(env.PROJECT_TOKEN) && !env.DRY_RUN;
const TOKEN = env.PROJECT_TOKEN || env.GITHUB_TOKEN;

async function rest(path) {
  const r = await fetch(`https://api.github.com/repos/${env.REPO}/${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN || TOKEN}`, Accept: "application/vnd.github+json" } });
  return r.ok ? r.json() : null;
}

async function gql(query, variables) {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map(e => e.message).join("; "));
  return j.data;
}

/** Everything the change says about itself: commit messages, plus the PR text where there is one. */
async function changeText(mode) {
  if (mode === "pr") {
    return [env.PR_TITLE, env.PR_BODY, git("log", "--format=%B%x00", `${env.BASE_SHA}..${env.HEAD_SHA}`)].join("\n");
  }
  if (ZERO.test(env.AFTER || "")) return "";                                     // branch deleted
  const range = ZERO.test(env.BEFORE || "") ? [env.AFTER, "--not", "--remotes=origin/main"] : [`${env.BEFORE}..${env.AFTER}`];
  const parts = [];
  for (const sha of git("rev-list", "--max-count=300", ...range).split("\n").filter(Boolean)) {
    const msg = git("log", "-1", "--format=%B", sha);
    parts.push(msg);
    const merged = msg.match(/^Merge pull request #(\d+)/);
    if (merged) {
      const pr = await rest(`pulls/${merged[1]}`);
      if (pr) parts.push(`${pr.title}\n${pr.body || ""}`);
    }
  }
  return parts.join("\n");
}

async function project() {
  const d = await gql(`query($o:String!,$n:Int!){organization(login:$o){projectV2(number:$n){id
    field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}`, { o: OWNER, n: NUMBER });
  const p = d.organization.projectV2;
  return { id: p.id, field: p.field.id, options: new Map(p.field.options.map(o => [o.name, o.id])) };
}

async function issue(repo, number) {
  const [owner, name] = repo.split("/");
  const d = await gql(`query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){id state title
    projectItems(first:20){nodes{id project{id} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}`,
    { o: owner, r: name, n: number });
  return d.repository.issue;
}

async function main() {
  const mode = process.argv[2];
  if (!["pr", "push"].includes(mode)) { console.error("usage: board-status.mjs pr|push"); return 2; }
  const refs = issueRefs(await changeText(mode), env.REPO).filter(r => r.repo.split("/")[0] === OWNER);
  if (!refs.length) { console.log("This change names no issue; nothing to move."); return 0; }
  if (!env.PROJECT_TOKEN) {                                // GITHUB_TOKEN can't even read an org project
    console.log(`::warning::PROJECT_WRITE_TOKEN is not set, so the board was not updated. This change names: ${
      refs.map(r => `${r.repo}#${r.number}`).join(", ")}`);
    return 0;
  }

  const board = await project();
  const lines = [];
  for (const ref of refs) {
    const label = `${ref.repo === env.REPO ? "" : ref.repo}#${ref.number}`;
    let it;
    try { it = await issue(ref.repo, ref.number); } catch { lines.push(`${label}: not an issue (a PR, or not readable); skipped`); continue; }
    if (!it) { lines.push(`${label}: not found; skipped`); continue; }
    if (it.state !== "OPEN") { lines.push(`${label}: closed; left alone`); continue; }
    const item = it.projectItems.nodes.find(n => n.project.id === board.id);
    const to = nextStatus(item?.fieldValueByName?.name);
    if (!to) { lines.push(`${label}: already ${item.fieldValueByName.name}`); continue; }
    lines.push(`${label}: ${item ? item.fieldValueByName?.name || "no status" : "not on the board"} -> ${to}${WRITE ? "" : " (not written)"}  ${it.title}`);
    if (!WRITE) continue;
    const itemId = item?.id || (await gql(`mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}`,
      { p: board.id, c: it.id })).addProjectV2ItemById.item.id;
    await gql(`mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,
      value:{singleSelectOptionId:$o}}){projectV2Item{id}}}`, { p: board.id, i: itemId, f: board.field, o: board.options.get(to) });
  }
  console.log(lines.join("\n"));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Project board\n\n${lines.map(l => `- ${l}`).join("\n")}\n`);
  return 0;
}

process.exitCode = await main();
