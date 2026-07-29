// News Radar poller — fetches curated RSS/Atom feeds, filters items against
// BBQS keywords, and inserts new candidates into `news_candidates` for
// admin review. Idempotent via unique(url).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/auth.ts";

const FEEDS: { name: string; url: string }[] = [
  { name: "NIH Director's Blog", url: "https://directorsblog.nih.gov/feed/" },
  { name: "NIMH News", url: "https://www.nimh.nih.gov/news/science-news/rss.xml" },
  { name: "Nature Neuroscience", url: "https://www.nature.com/neuro.rss" },
  { name: "Neuron (Cell Press)", url: "https://www.cell.com/neuron/current.rss" },
  { name: "NYT Science", url: "https://rss.nytimes.com/services/xml/rss/nyt/Science.xml" },
  { name: "Quanta Magazine — Biology", url: "https://www.quantamagazine.org/feed/" },
  { name: "STAT News — Brain", url: "https://www.statnews.com/category/neuroscience/feed/" },
];

// BBQS interest profile — tune freely; matches are case-insensitive substrings.
const KEYWORDS = [
  "brain", "neuro", "neural", "cognition", "behavior", "behaviour",
  "primate", "monkey", "mouse", "zebrafish", "rodent",
  "EEG", "fMRI", "MEG", "ECoG", "Neuropixels", "electrophysiology",
  "psychiatr", "depression", "anxiety", "autism", "adhd",
  "AI", "machine learning", "deep learning", "foundation model",
  "biomarker", "wearable", "heart rate", "HRV",
  "consortium", "BRAIN Initiative", "NIH",
];

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function pick(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  const inner = m[1].trim();
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (cdata ? cdata[1] : inner).trim();
}

function pickAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]*\\b${attr}="([^"]+)"`, "i");
  const m = xml.match(re);
  return m ? m[1] : null;
}

type Item = {
  title: string;
  url: string;
  summary: string;
  author: string | null;
  published_at: string | null;
};

function parseFeed(xml: string): Item[] {
  const items: Item[] = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) ?? [];
  for (const b of blocks) {
    const title = stripTags(pick(b, "title") ?? "");
    let url = pick(b, "link") ?? "";
    if (!url || url.startsWith("<")) url = pickAttr(b, "link", "href") ?? "";
    const summary = stripTags(
      pick(b, "description") ?? pick(b, "summary") ?? pick(b, "content") ?? "",
    ).slice(0, 800);
    const author = stripTags(
      pick(b, "dc:creator") ?? pick(b, "author") ?? "",
    ) || null;
    const pubRaw = pick(b, "pubDate") ?? pick(b, "published") ?? pick(b, "updated");
    let published_at: string | null = null;
    if (pubRaw) {
      const d = new Date(pubRaw);
      if (!isNaN(d.getTime())) published_at = d.toISOString();
    }
    if (title && url) items.push({ title, url, summary, author, published_at });
  }
  return items;
}

function scoreItem(it: Item): { score: number; matched: string[] } {
  const hay = `${it.title} ${it.summary}`.toLowerCase();
  const matched: string[] = [];
  for (const kw of KEYWORDS) {
    if (hay.includes(kw.toLowerCase())) matched.push(kw);
  }
  return { score: matched.length, matched };
}

Deno.serve(async (req) => {
  const headers = { ...getCorsHeaders(req), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { headers });

  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, service);

  const perFeed: Record<string, { fetched: number; kept: number; inserted: number; error?: string }> = {};
  let totalInserted = 0;

  for (const feed of FEEDS) {
    const stats = { fetched: 0, kept: 0, inserted: 0 } as { fetched: number; kept: number; inserted: number; error?: string };
    try {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "BBQS-NewsRadar/1.0 (+https://brain-bbqs.org)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const items = parseFeed(xml);
      stats.fetched = items.length;

      const rows = items
        .map((it) => {
          const { score, matched } = scoreItem(it);
          return { it, score, matched };
        })
        .filter(({ score }) => score >= 1)
        .map(({ it, score, matched }) => ({
          source: feed.name,
          source_url: feed.url,
          title: it.title.slice(0, 500),
          url: it.url,
          summary: it.summary,
          author: it.author,
          published_at: it.published_at,
          matched_keywords: matched,
          score,
          status: "pending",
        }));
      stats.kept = rows.length;

      if (rows.length) {
        const { data, error } = await admin
          .from("news_candidates")
          .upsert(rows, { onConflict: "url", ignoreDuplicates: true })
          .select("id");
        if (error) throw error;
        stats.inserted = data?.length ?? 0;
        totalInserted += stats.inserted;
      }
    } catch (e) {
      stats.error = e instanceof Error ? e.message : String(e);
    }
    perFeed[feed.name] = stats;
  }

  return new Response(
    JSON.stringify({ ok: true, totalInserted, perFeed, ranAt: new Date().toISOString() }),
    { headers },
  );
});