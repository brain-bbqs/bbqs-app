// Centralized list of working group chair names for cross-referencing
const WG_CHAIRS: { name: string; group: string }[] = [
  { name: "Kristofer Bouchard", group: "WG-Analytics" },
  { name: "Han Yi", group: "WG-Analytics" },
  { name: "Alireza Kazemi", group: "WG-Devices" },
  { name: "Uros Topalovic", group: "WG-Devices" },
  { name: "Laura Cabrera", group: "WG-ELSI" },
  { name: "Oliver Ruebel", group: "WG-Standards" },
  { name: "Melissa Kline Struhl", group: "WG-Standards" },
  { name: "Steve Chang", group: "WG-Cross-Species" },
  { name: "Dan Sanes", group: "WG-Cross-Species" },
];

function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\s]+/g, " ")
    .trim();
}

// Extract key name parts (first name + last name fragments) for each chair
const chairNameParts = WG_CHAIRS.map((c) => {
  const parts = normalize(c.name).split(" ");
  return { parts, firstName: parts[0], lastName: parts[parts.length - 1] };
});

/**
 * Check if a display name matches a working group chair.
 * Uses normalized partial matching: if the investigator's name contains
 * both the chair's first name and last name, it's a match.
 */
export function isWorkingGroupChair(displayName: string): boolean {
  const norm = normalize(displayName);

  for (const chair of chairNameParts) {
    // Check if investigator name contains both the first and last name of the chair
    const hasFirst = norm.includes(chair.firstName);
    const hasLast = norm.includes(chair.lastName);
    if (hasFirst && hasLast) return true;
  }

  return false;
}

export function getAllWorkingGroupChairNames(): Set<string> {
  return new Set(WG_CHAIRS.map((c) => c.name.toLowerCase()));
}

export { WG_CHAIRS };
