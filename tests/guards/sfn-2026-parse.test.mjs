// Guard: the /sfn-2026 schedule is parsed from free-text form answers (sfn-2026-presentations).
//
// WHY. The form asks for "[Date, Time] [Number] - Title - Keywords" but nobody answers in that shape;
// the fixture is the published tab as it stood on 2026-10-21, with every format seen so far. A parser
// change that misreads one of them silently drops or garbles a poster on a public page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePresentations, parseAnswer } from "../../supabase/functions/sfn-2026-presentations/parse.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const csv = readFileSync(join(HERE, "fixtures", "sfn-2026-website-tab.csv"), "utf8");
const all = parsePresentations(csv);
const byNumber = (n) => all.find((p) => p.number === n);

test("every presentation in the real answers is found, duplicates merged", () => {
  assert.equal(all.length, 14);
  assert.equal(all.filter((p) => p.day == null).length, 1, "only the link-only answer lacks a day");
});

test("bracketed, bare, slash-dated and tagged formats each parse", () => {
  assert.deepEqual(
    (({ day, time, title }) => ({ day, time, title }))(byNumber("PSTR250.04")),
    { day: 17, time: "8:00 AM", title: "Topological data analysis reveals transient neural states in ferrets during naturalistic social interaction" },
  );
  assert.equal(byNumber("PSTR060.13").title.startsWith("Context-Aware Multimodal"), true, "[Presentation Number: …] is not the title");
  assert.equal(byNumber("#8372").time, "1:00–5:00 PM", "'1-5pm' is afternoon");
  assert.equal(byNumber("#3652").title, "Graph Bispectrum Reveals Increased Nonlinear Cortical Coupling During Live Social Interaction in First-Episode Psychosis");
  assert.equal(byNumber("#3652").day, 17, "'Tuesday 11/17/2026 1:00:00 PM' gives the day");
  assert.equal(byNumber("PSTR142.14").title, "Two-scale temporal organization of vocal communication in Mongolian gerbil families");
  const talk = all.find((p) => p.presenters.includes("Dayu Lin"));
  assert.deepEqual([talk.day, talk.time, talk.number, talk.title], [16, "10:30–11:30 AM", null, "Social behaviors: Innate yet flexible"]);
});

test("co-presenters who each submitted the poster become one entry", () => {
  assert.deepEqual(byNumber("PSTR060.13").presenters, ["Hongkun Zhu", "Kun Zhao"]);
  const reliability = byNumber("PSTR116");
  assert.deepEqual(reliability.presenters, ["Joy Hirsch", "Adam Noah"], "'NIRS-fMRI' and 'fNIRS-fMRI' titles match");
  assert.equal(all.filter((p) => p.presenters.includes("Joy Hirsch")).length, 5, "Joy's five distinct posters stay five");
});

test("non-answers and note lines are dropped, link-only answers kept", () => {
  for (const a of ["NA", "N/A", "none", "No poster", "Not presenting"]) assert.deepEqual(parseAnswer("X", a), [], a);
  const social = parseAnswer("X", "November 16, 7–9 pm, Some Social (Hall E) - details\nEvent Organizer: Someone");
  assert.equal(social.length, 1, "the organizer line is a note, not a presentation");
  assert.equal(all.find((p) => p.day == null).link, "https://www.abstractsonline.com/pp8/#!/21503/presentation/27321");
});
