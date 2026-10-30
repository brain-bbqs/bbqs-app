// WG-Standards documents, maintained in https://github.com/brain-bbqs/bbqs-standards and
// copied into src/content/standards/ by scripts/fetch-standards-docs.mjs before dev/build.
// Each document is content/<slug>/index.md with front matter; figures live next to it.

export const STANDARDS_REPO_URL = "https://github.com/brain-bbqs/bbqs-standards";
export const STANDARDS_BASE_PATH = "/working-groups/standards";

export interface StandardsDoc {
  slug: string;
  title: string;
  shortTitle: string;
  description: string;
  order: number;
  body: string;
  sourceUrl: string;
}

// Paths are relative to this file. Both globs are empty if the fetch script has not run,
// in which case the pages show a "not available" notice instead of failing.
const sources = import.meta.glob("../content/standards/*/index.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const assets = import.meta.glob("../content/standards/*/**/*.{svg,png,jpg,jpeg,gif,webp,pdf,pptx}", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Front matter is flat `key: value` lines (bbqs-standards' check_docs.py enforces this),
 *  so a full YAML parser is not needed. Values may be quoted; integers become numbers. */
function parseFrontMatter(text: string): Record<string, string | number> {
  const meta: Record<string, string | number> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][\w-]*):\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    meta[match[1]] = /^-?\d+$/.test(value) ? Number(value) : value;
  }
  return meta;
}

function parse(file: string, raw: string): StandardsDoc {
  const slug = file.split("/").at(-2)!;
  const match = raw.match(FRONT_MATTER);
  const meta = match ? parseFrontMatter(match[1]) : {};
  const title = typeof meta.title === "string" ? meta.title : slug;
  return {
    slug,
    title,
    shortTitle: typeof meta.short_title === "string" ? meta.short_title : title,
    description: typeof meta.description === "string" ? meta.description : "",
    order: typeof meta.order === "number" ? meta.order : Number.MAX_SAFE_INTEGER,
    body: match ? raw.slice(match[0].length) : raw,
    sourceUrl: `${STANDARDS_REPO_URL}/blob/main/content/${slug}/index.md`,
  };
}

export const standardsDocs: StandardsDoc[] = Object.entries(sources)
  .map(([file, raw]) => parse(file, raw))
  .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

export function getStandardsDoc(slug: string | undefined): StandardsDoc | undefined {
  return standardsDocs.find((doc) => doc.slug === slug);
}

/**
 * Resolves a link or image target written relative to a document (as on GitHub) to
 * where it lives on the site: bundled figures get their built asset URL, links to other
 * documents (`../charter/index.md#goals`) become site routes, and links to any other
 * file in the repository go to GitHub. Absolute URLs and in-page anchors pass through.
 */
export function resolveDocUrl(slug: string, target: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) {
    return target;
  }
  const [pathPart, hash = ""] = target.split("#");
  const parts = `${slug}/${decodeURIComponent(pathPart)}`.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part && part !== ".") resolved.push(part);
  }
  const repoPath = resolved.join("/");
  const asset = assets[`../content/standards/${repoPath}`];
  if (asset) return asset;
  const docLink = repoPath.match(/^([^/]+)\/(index\.md)?$/) ?? repoPath.match(/^([^/]+)$/);
  if (docLink && getStandardsDoc(docLink[1])) {
    return `${STANDARDS_BASE_PATH}/${docLink[1]}${hash ? `#${hash}` : ""}`;
  }
  return `${STANDARDS_REPO_URL}/blob/main/content/${repoPath}${hash ? `#${hash}` : ""}`;
}

/** GitHub-style heading anchor, so `#some-heading` links behave as they do on GitHub. */
export function headingId(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
