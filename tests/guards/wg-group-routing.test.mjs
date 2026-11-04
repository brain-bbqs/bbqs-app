import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// sync-member-groups decides which wg-*@ Google Group a person joins from a working-group string.
// Onboarding-form option texts describe each group in words that belong to OTHER groups: the
// Standards option promotes "ethically aligned ... data standards", so a substring check for
// "ethic" that runs before "standard" puts every Standards member in wg-elsi@. The bbqs-agent
// importer has exactly that bug. This runs the deployed function against the form's real texts.

const src = readFileSync(new URL("../../supabase/functions/sync-member-groups/index.ts", import.meta.url), "utf8");
const m = src.match(/function normaliseWG\(raw: string\): string \| null \{([\s\S]*?)\n\}/);
assert.ok(m, "could not find normaliseWG in sync-member-groups/index.ts");
const normaliseWG = new Function("raw", m[1]);

// Verbatim option texts from the BBQS Consortium Onboarding Form, as stored in its responses.
const FORM_OPTIONS = {
  wg_analytics: "WG-Analytics (Chair(s): Kristofer Bouchard, Han Yi) will focus on identifying challenges within the consortium in developing, benchmarking, and validating models (algorithmic or AI driven) or processing pipelines for behavioral and synchronized neural and behavioral data.",
  wg_devices: "WG-Devices (Chair(s): Yet to be determined) will focus on sharing knowledge of sensor development, existing sensors, especially related to their capabilities and limitations in the context of BBQS projects.",
  wg_elsi: "WG-ELSI (Ethics, Legal, and Social Issues) (Chair(s): Laura Cabrera) will focus on establishing ethical frameworks to guide research, data collection, and data dissemination and reuse within and outside the consortium.",
  wg_standards: "WG-Standards (Chair(s): Oliver Ruebel, Melissa Kline Struhl) will facilitate FAIR sharing and reuse of behavior data by facilitating and promoting the adoption and development of ethically aligned and more efficient data standards.",
};

// Not verbatim: a constructed option whose description names every other group's keyword, so any
// future description that does the same is caught, not just the Standards one we already know.
FORM_OPTIONS.wg_cross_species =
  "WG-Cross-species (Chair(s): Steve Chang, Dan Sanes) will develop tools, methods, and models that use data from different species, including standards-aware analytics of devices and ethics.";

for (const [key, text] of Object.entries(FORM_OPTIONS)) {
  test(`the ${key} form option routes to ${key}`, () => {
    assert.equal(normaliseWG(text), key);
  });
}

test("stored tokens and free-text names still route", () => {
  const cases = {
    "WG-Analytics": "wg_analytics", "WG-Devices": "wg_devices", "WG-ELSI": "wg_elsi",
    "WG-Standards": "wg_standards", "WG-Cross-Species": "wg_cross_species",
    "Ethics": "wg_elsi", "Standards": "wg_standards", "cross species": "wg_cross_species",
  };
  for (const [input, key] of Object.entries(cases)) assert.equal(normaliseWG(input), key, input);
});
