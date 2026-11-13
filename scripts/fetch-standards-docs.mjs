#!/usr/bin/env node
// Fetches the WG-Standards documents (guidelines, charter, ...) into src/content/standards/.
//
// The documents are maintained as Markdown in https://github.com/brain-bbqs/bbqs-standards
// (content/<slug>/index.md plus figures) and are not committed here. This runs before
// `vite` / `vite build` (see the pre* scripts in package.json); src/lib/standardsDocs.ts
// bundles whatever it finds, and the /working-groups/standards pages render it.
//
// Environment:
//   BBQS_STANDARDS_PATH  use a local checkout of bbqs-standards instead of downloading
//                        (to preview document edits before they are merged)
//   BBQS_STANDARDS_REF   branch, tag, or commit to download (default: main)
//   BBQS_STANDARDS_TOKEN GitHub token with read access, only needed while the repository
//                        is private
//
// A failed download fails the build in CI (CI=true), so a GitHub outage never publishes
// the site without the documents; the previous deploy stays live. Locally it only warns,
// and the pages show a "not available" notice.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "brain-bbqs/bbqs-standards";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "src", "content", "standards");

function install(contentDir, source) {
  rmSync(dest, { recursive: true, force: true });
  cpSync(contentDir, dest, { recursive: true });
  writeFileSync(path.join(dest, "SOURCE"), `${source}\n`);
  console.log(`[standards-docs] ${source} -> ${path.relative(root, dest)}`);
}

async function download(ref) {
  const token = process.env.BBQS_STANDARDS_TOKEN;
  const url = `https://api.github.com/repos/${REPO}/tarball/${ref}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", ...(token && { Authorization: `Bearer ${token}` }) },
  });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const tmp = mkdtempSync(path.join(tmpdir(), "bbqs-standards-"));
  try {
    const archive = path.join(tmp, "repo.tar.gz");
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    execFileSync("tar", ["-xzf", archive, "-C", tmp, "--strip-components=1"]);
    const content = path.join(tmp, "content");
    if (!existsSync(content)) throw new Error(`${REPO}@${ref} has no content/ directory`);
    install(content, `${REPO}@${ref}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const local = process.env.BBQS_STANDARDS_PATH;
if (local) {
  install(path.join(path.resolve(local), "content"), `local:${path.resolve(local)}`);
} else {
  try {
    await download(process.env.BBQS_STANDARDS_REF || "main");
  } catch (err) {
    if (process.env.CI) {
      console.error(`[standards-docs] ${err.message}`);
      process.exit(1);
    }
    console.warn(`[standards-docs] ${err.message}`);
    console.warn(
      existsSync(dest)
        ? "[standards-docs] keeping the previously fetched copy"
        : "[standards-docs] continuing without the documents",
    );
  }
}
