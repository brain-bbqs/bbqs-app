// Turns the free-text answers on the SfN form's published "Website" tab into a schedule. The
// question asks for "[Date, Time] [Number] - Title - Keywords", but answers arrive in many shapes
// ("[Nov. 17, 8:00am][PSTR250.04] - …", "[Date, Time; Sunday, November 15, 2026, 8:00 AM – …]
// [Number: 3481] [Title: …]", "11/16, 10:30-11:30am, …", a bare abstract link), so the parser reads
// a leading date/time run, then a number anywhere, then the title.

export type Presentation = {
  day: number | null;      // day of November 2026
  start: number | null;    // minutes after midnight
  end: number | null;
  time: string | null;     // "8:00 AM–12:00 PM"
  number: string | null;   // "PSTR250.04", or "#3481" when only an abstract number was given
  title: string;
  presenters: string[];
  link: string | null;
};

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { cur.push(field); field = ""; }
    else if (c === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

const WEEKDAY = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thur?s?|fri|sat|sun)\\b\\.?";
const MONTH_DAY = "nov(?:ember)?\\.?\\s*(\\d{1,2})\\b";
const SLASH_DAY = "11/(\\d{1,2})(?:/(?:20)?26)?\\b";
const TIME = "(\\d{1,2})(?::(\\d{2}))?(?::\\d{2})?\\s*(?:([ap])\\.?m\\.?)?(?![\\w.])";
// One token of the leading date/time run. Separators are consumed too, so "] - " before a title
// disappears with the run.
const WHEN_TOKEN = new RegExp(
  `^(?:[\\s\\[\\],;:–—-]+|date\\s*,\\s*time\\b|${WEEKDAY}|${MONTH_DAY}|${SLASH_DAY}|2026\\b|${TIME})`,
  "i",
);

type Clock = { h: number; m: number; mer: "a" | "p" | null };

const minutes = (c: Clock, mer: "a" | "p") => ((c.h % 12) + (mer === "p" ? 12 : 0)) * 60 + c.m;

function readWhen(entry: string) {
  let rest = entry;
  let day: number | null = null;
  const clocks: Clock[] = [];
  for (;;) {
    const m = rest.match(WHEN_TOKEN);
    if (!m || !m[0]) break;
    const tok = m[0];
    const d = tok.match(new RegExp(`^${MONTH_DAY}|^${SLASH_DAY}`, "i"));
    if (d) day ??= Number(d[1] ?? d[2]);
    else {
      const t = tok.match(new RegExp(`^${TIME}$`, "i"));
      if (t) clocks.push({ h: Number(t[1]), m: Number(t[2] ?? 0), mer: (t[3]?.toLowerCase() as "a" | "p") ?? null });
    }
    rest = rest.slice(tok.length);
  }
  // Give back an opening bracket the separators swallowed: it starts "[Number: …]", not the run.
  const opened = entry.slice(0, entry.length - rest.length).match(/\[\s*$/);
  if (opened) rest = opened[0] + rest;
  return { day, clocks, rest };
}

function fmt(c: Clock) {
  return `${c.h % 12 === 0 ? 12 : c.h % 12}:${String(c.m).padStart(2, "0")}`;
}

function readTime(clocks: Clock[]) {
  if (!clocks.length) return { start: null, end: null, time: null };
  const first = clocks[0];
  const last = clocks.length > 1 ? clocks[clocks.length - 1] : null;
  if (!last) {
    if (!first.mer) return { start: null, end: null, time: null };
    return { start: minutes(first, first.mer), end: null, time: `${fmt(first)} ${first.mer.toUpperCase()}M` };
  }
  let sm = first.mer;
  let em = last.mer ?? sm;
  if (!em) return { start: null, end: null, time: null };
  if (!sm) {
    // "8-12pm" is morning, "1-5pm" is afternoon: take the end's meridiem unless that puts the start
    // after the end.
    sm = minutes(first, em) < minutes(last, em) ? em : em === "p" ? "a" : "p";
  }
  if (!last.mer && minutes(last, em) <= minutes(first, sm)) em = em === "a" ? "p" : "a";
  const S = sm.toUpperCase() + "M";
  const E = em.toUpperCase() + "M";
  const time = sm === em ? `${fmt(first)}–${fmt(last)} ${E}` : `${fmt(first)} ${S}–${fmt(last)} ${E}`;
  return { start: minutes(first, sm), end: minutes(last, em), time };
}

function readNumber(entry: string): string | null {
  const pstr = entry.match(/\bPSTR\s*(\d+(?:\.\d+)?)/i);
  if (pstr) return `PSTR${pstr[1]}`;
  const abs = entry.match(/(?:\bnumber:?\s*|#)(\d{3,5})\b/i);
  return abs ? `#${abs[1]}` : null;
}

function readTitle(entry: string, rest: string): string {
  const tagged = entry.match(/\[\s*title:\s*([^\]]+)\]/i);
  const raw = tagged
    ? tagged[1]
    : rest
        .replace(/\[[^\]]*(?:number|pstr|#)[^\]]*\]/gi, " ")
        .replace(/\[\s*keywords:[^\]]*\]/gi, " ")
        .replace(/\bPSTR\s*\d+(?:\.\d+)?/gi, " ")
        .replace(/#\d+/g, " ")
        .replace(/^[\s[\]:,;–—-]+/, "")
        .split(/\s+-\s+/)[0];
  return raw.replace(/[\s.\]]+$/, "").replace(/\s+/g, " ").trim();
}

/** One form answer → its presentations. Lines that carry no date, number or link are notes and are
 *  dropped, except when the whole answer is one such line long enough to be a title. */
export function parseAnswer(name: string, answer: string): Presentation[] {
  const lines = answer.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: Presentation[] = [];
  for (const line of lines) {
    const link = line.match(/https?:\/\/\S+/)?.[0] ?? null;
    const { day, clocks, rest } = readWhen(line);
    const number = readNumber(line);
    const title = link && line.trim() === link ? "" : readTitle(line, rest);
    if (day == null && !number && !link && (out.length || title.length < 15)) continue;
    out.push({ day, ...readTime(clocks), number, title, presenters: [name], link });
  }
  return out;
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);

function similar(a: string, b: string) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return false;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both) >= 0.8;
}

function samePresentation(a: Presentation, b: Presentation) {
  if (a.day !== b.day) return false;
  if (a.number && b.number) {
    if (a.number === b.number) return true;
    if (a.number[0] === b.number[0]) return false; // two different numbers of the same kind
  }
  return similar(a.title, b.title);
}

/** Co-presenters often submit the same poster separately; fold those into one entry. */
export function mergeDuplicates(items: Presentation[]): Presentation[] {
  const out: Presentation[] = [];
  for (const p of items) {
    const hit = out.find((q) => samePresentation(p, q));
    if (!hit) { out.push({ ...p, presenters: [...p.presenters] }); continue; }
    for (const n of p.presenters) if (!hit.presenters.includes(n)) hit.presenters.push(n);
    if (!hit.number || (p.number?.startsWith("PSTR") && !hit.number.startsWith("PSTR"))) hit.number = p.number;
    if (p.title.length > hit.title.length) hit.title = p.title;
    if (hit.end == null && p.end != null) Object.assign(hit, { start: p.start, end: p.end, time: p.time });
    hit.link ??= p.link;
  }
  return out;
}

/** The published tab's CSV → merged presentations, sorted by day then start time. `fill` can
 *  complete an entry the answer left short, such as one given only as an abstract link. */
export function parsePresentations(
  csv: string,
  fill: (p: Presentation) => Partial<Presentation> | null = () => null,
): Presentation[] {
  const [header, ...rows] = parseCsv(csv);
  if (!header) return [];
  const h = header.map((c) => c.toLowerCase());
  const iName = h.findIndex((c) => c.trim() === "name");
  const iAnswer = h.findIndex((c) => c.includes("poster"));
  if (iName < 0 || iAnswer < 0) throw new Error(`unexpected columns: ${header.join(" | ").slice(0, 200)}`);
  const all = rows
    .flatMap((r) => (r[iName]?.trim() ? parseAnswer(r[iName].trim(), r[iAnswer] ?? "") : []))
    .map((p) => ({ ...p, ...fill(p) }));
  return mergeDuplicates(all).sort((a, b) =>
    (a.day ?? 99) - (b.day ?? 99) || (a.start ?? 9999) - (b.start ?? 9999) || a.title.localeCompare(b.title));
}
