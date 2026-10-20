// What counts as "tracked work" -- shared by the work-tracking workflow and its guard test.
//
// A change is tracked when it names its issue with a keyword: "Refs #421", "Closes #12",
// "Part of brain-bbqs/bbqs-app#386", or an issue URL. A bare "#7" is not enough: commits here
// say "#7" and "#19" for KG invariants, and those are not issues. A change is trivial when it is
// labelled or tagged [trivial], or small once generated files are left out.

const KEYWORD = String.raw`(?:refs?|references|close[sd]?|fix(?:e[sd])?|resolve[sd]?|part of|tracks|tracked (?:in|by)|see|for)`;
const ISSUE = String.raw`(?:[\w.-]+\/[\w.-]+)?#\d+`;
const REF = new RegExp(String.raw`\b${KEYWORD}:?\s+${ISSUE}\b|github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+`, "i");

export const TINY = { lines: 40, files: 3 };

// Outputs a script or a build writes; their size says nothing about how much work went in.
export const GENERATED = [
  /^kg\/browser\/index\.html$/, /^kg\/export\//, /^kg\/explorer\/.*\.json$/, /^kg\/bbqs\.(owl|shapes\.gen)\.ttl$/,
  /^kg\/sosa\/.*\.sosa\.ttl$/, /^src\/integrations\/supabase\/types\.ts$/, /(^|\/)package-lock\.json$/, /\.lock$/,
];

export const referencesIssue = text => REF.test(text || "");
export const markedTrivial = text => /\[trivial\]/i.test(text || "");

/** numstat lines ("12\t3\tpath") -> {lines, files}, leaving out generated files and binaries. */
export function size(numstat) {
  let lines = 0, files = 0;
  for (const row of (numstat || "").split("\n")) {
    const [add, del, path] = row.split("\t");
    if (!path || GENERATED.some(re => re.test(path))) continue;
    files += 1;
    if (add !== "-") lines += Number(add) + Number(del);
  }
  return { lines, files };
}

export const isTiny = s => s.lines <= TINY.lines && s.files <= TINY.files;
