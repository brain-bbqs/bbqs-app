// Canonical BBQS type hierarchy, aligned to schema.org.
// Frontend-only source of truth — no DB coupling. Pages/tables listed under
// `instancesFrom` are informational pointers.

export type SchemaProperty = {
  name: string;
  expectedType: string;
  schemaOrgEquivalent?: string; // full URL to schema.org property when one exists
  note?: string;
};

export type BbqsType = {
  key: string;                 // e.g. "bbqs:Investigator"
  label: string;
  description: string;
  parent?: string;             // parent BBQS key OR schema:* root
  subClassOf?: string;         // schema.org URL
  properties: SchemaProperty[];
  instancesFrom?: { label: string; path?: string }[];
  examples?: string[];
};

const P = (name: string, expectedType: string, schemaOrgEquivalent?: string, note?: string): SchemaProperty =>
  ({ name, expectedType, schemaOrgEquivalent, note });

// Schema.org root anchors we hang BBQS types under. These render as
// non-clickable parents in the tree so users can see the alignment.
export const SCHEMA_ROOTS: BbqsType[] = [
  { key: "schema:Thing", label: "schema:Thing", description: "The most generic type on schema.org.", subClassOf: "https://schema.org/Thing", properties: [] },
  { key: "schema:Organization", label: "schema:Organization", description: "An organization such as a school, NGO, corporation, club, or funding body.", parent: "schema:Thing", subClassOf: "https://schema.org/Organization", properties: [] },
  { key: "schema:Person", label: "schema:Person", description: "A person (alive, dead, undead, or fictional).", parent: "schema:Thing", subClassOf: "https://schema.org/Person", properties: [] },
  { key: "schema:Project", label: "schema:Project", description: "An enterprise (potentially individual but typically collaborative), planned to achieve a particular aim.", parent: "schema:Thing", subClassOf: "https://schema.org/Project", properties: [] },
  { key: "schema:Grant", label: "schema:Grant", description: "A grant, typically financial or otherwise quantifiable, of resources.", parent: "schema:Thing", subClassOf: "https://schema.org/Grant", properties: [] },
  { key: "schema:CreativeWork", label: "schema:CreativeWork", description: "The most generic kind of creative work, including books, articles, software, datasets.", parent: "schema:Thing", subClassOf: "https://schema.org/CreativeWork", properties: [] },
  { key: "schema:JobPosting", label: "schema:JobPosting", description: "A listing that describes a job opening in a certain organization.", parent: "schema:Thing", subClassOf: "https://schema.org/JobPosting", properties: [] },
  { key: "schema:Taxon", label: "schema:Taxon", description: "A set of organisms asserted to represent a natural cohesive biological unit.", parent: "schema:Thing", subClassOf: "https://schema.org/Taxon", properties: [] },
  { key: "schema:Product", label: "schema:Product", description: "Any offered product or service — here specialized as scientific instruments.", parent: "schema:Thing", subClassOf: "https://schema.org/Product", properties: [] },
  { key: "schema:Event", label: "schema:Event", description: "An event happening at a certain time and location.", parent: "schema:Thing", subClassOf: "https://schema.org/Event", properties: [] },
];

// BBQS-specific types.
export const BBQS_TYPES: BbqsType[] = [
  // ---- Organizations
  {
    key: "bbqs:Consortium",
    label: "bbqs:Consortium",
    description: "The BBQS Consortium itself — a multi-institution NIH-funded research collective.",
    parent: "schema:Organization",
    subClassOf: "https://schema.org/Organization",
    properties: [
      P("name", "Text", "https://schema.org/name"),
      P("url", "URL", "https://schema.org/url"),
      P("member", "bbqs:ResearchOrganization", "https://schema.org/member"),
      P("funder", "bbqs:FundingAgency", "https://schema.org/funder"),
    ],
    examples: ["BBQS Consortium (NIH BRAIN Initiative)"],
  },
  {
    key: "bbqs:ResearchOrganization",
    label: "bbqs:ResearchOrganization",
    description: "A university, institute, or lab that participates in BBQS.",
    parent: "schema:Organization",
    subClassOf: "https://schema.org/ResearchOrganization",
    properties: [
      P("name", "Text", "https://schema.org/name"),
      P("url", "URL", "https://schema.org/url"),
      P("employee", "bbqs:Investigator", "https://schema.org/employee"),
    ],
    instancesFrom: [{ label: "About", path: "/about" }],
    examples: ["Stony Brook University", "Penn State University", "MIT"],
  },
  {
    key: "bbqs:FundingAgency",
    label: "bbqs:FundingAgency",
    description: "An organization that funds BBQS research (typically NIH).",
    parent: "schema:Organization",
    subClassOf: "https://schema.org/FundingAgency",
    properties: [
      P("name", "Text", "https://schema.org/name"),
      P("identifier", "Text", "https://schema.org/identifier", "e.g. NIH institute code (NIMH, NIDA, NINDS)"),
    ],
    examples: ["NIMH", "NIDA", "NINDS"],
  },

  // ---- People
  {
    key: "bbqs:Investigator",
    label: "bbqs:Investigator",
    description: "A person named on a BBQS grant or contributing to a BBQS project — PI, co-I, trainee, or collaborator.",
    parent: "schema:Person",
    subClassOf: "https://schema.org/Person",
    properties: [
      P("givenName", "Text", "https://schema.org/givenName"),
      P("familyName", "Text", "https://schema.org/familyName"),
      P("email", "Text", "https://schema.org/email", "Primary + secondary emails; PII, restricted."),
      P("affiliation", "bbqs:ResearchOrganization", "https://schema.org/affiliation"),
      P("orcid", "URL", "https://schema.org/identifier"),
      P("role", "Text", undefined, "BBQS role: PI, Co-I, Trainee, Collaborator."),
      P("worksOn", "bbqs:FundedProject", "https://schema.org/worksFor"),
    ],
    instancesFrom: [{ label: "Principal Investigators", path: "/investigators" }],
    examples: ["Charles Mikell", "Petar M Djuric", "Sima Mofakham"],
  },

  // ---- Projects
  {
    key: "bbqs:FundedProject",
    label: "bbqs:FundedProject",
    description: "A BBQS research project — typically the scientific work tied to one or more NIH awards.",
    parent: "schema:Project",
    subClassOf: "https://schema.org/ResearchProject",
    properties: [
      P("name", "Text", "https://schema.org/name"),
      P("description", "Text", "https://schema.org/description"),
      P("funding", "bbqs:NIHGrant", "https://schema.org/funding"),
      P("member", "bbqs:Investigator", "https://schema.org/member"),
      P("about", "bbqs:Species", "https://schema.org/about", "Species studied."),
      P("instrument", "bbqs:Device", undefined, "Devices used in the project."),
    ],
    instancesFrom: [{ label: "Projects", path: "/projects" }],
    examples: ["1R61MH138612 — SeeMe (Stony Brook)"],
  },

  // ---- Grants
  {
    key: "bbqs:NIHGrant",
    label: "bbqs:NIHGrant",
    description: "An NIH award funding BBQS work. Encodes the funding mechanism (R61, R34, RF1, etc.).",
    parent: "schema:Grant",
    subClassOf: "https://schema.org/MonetaryGrant",
    properties: [
      P("identifier", "Text", "https://schema.org/identifier", "Full NIH grant number, e.g. 1R61MH138612."),
      P("funder", "bbqs:FundingAgency", "https://schema.org/funder"),
      P("amount", "Number", "https://schema.org/amount"),
      P("startDate", "Date", "https://schema.org/startDate"),
      P("endDate", "Date", "https://schema.org/endDate"),
      P("mechanism", "Text", undefined, "BBQS-specific: R61, R34, RF1, U01, …"),
    ],
    instancesFrom: [{ label: "Projects", path: "/projects" }],
    examples: ["R61 planning grants", "R34 mental-health pilots", "RF1 mid-scale awards"],
  },

  // ---- CreativeWork subtypes
  {
    key: "bbqs:Publication",
    label: "bbqs:Publication",
    description: "A peer-reviewed publication produced under BBQS support.",
    parent: "schema:CreativeWork",
    subClassOf: "https://schema.org/ScholarlyArticle",
    properties: [
      P("headline", "Text", "https://schema.org/headline"),
      P("author", "bbqs:Investigator", "https://schema.org/author"),
      P("datePublished", "Date", "https://schema.org/datePublished"),
      P("identifier", "Text", "https://schema.org/identifier", "DOI or PMID."),
      P("isBasedOn", "bbqs:FundedProject", "https://schema.org/isBasedOn"),
    ],
    instancesFrom: [{ label: "Publications", path: "/publications" }],
  },
  {
    key: "bbqs:Dandiset",
    label: "bbqs:Dandiset",
    description: "A DANDI-archived dataset released by BBQS.",
    parent: "schema:CreativeWork",
    subClassOf: "https://schema.org/Dataset",
    properties: [
      P("name", "Text", "https://schema.org/name"),
      P("identifier", "URL", "https://schema.org/identifier", "DANDI URL."),
      P("about", "bbqs:Species", "https://schema.org/about"),
      P("measurementTechnique", "bbqs:Device", "https://schema.org/measurementTechnique"),
    ],
    instancesFrom: [{ label: "Resources", path: "/resources" }],
  },
  {
    key: "bbqs:SoftwareTool",
    label: "bbqs:SoftwareTool",
    description: "A software package, pipeline, or analysis library released by BBQS.",
    parent: "schema:CreativeWork",
    subClassOf: "https://schema.org/SoftwareApplication",
    properties: [
      P("name", "Text", "https://schema.org/name"),
      P("codeRepository", "URL", "https://schema.org/codeRepository"),
      P("applicationCategory", "Text", "https://schema.org/applicationCategory"),
    ],
    instancesFrom: [{ label: "Resources", path: "/resources" }],
    examples: ["EMBER", "NeuroMCP"],
  },
  {
    key: "bbqs:Announcement",
    label: "bbqs:Announcement",
    description: "A public consortium announcement or news post.",
    parent: "schema:CreativeWork",
    subClassOf: "https://schema.org/Article",
    properties: [
      P("headline", "Text", "https://schema.org/headline"),
      P("datePublished", "Date", "https://schema.org/datePublished"),
      P("author", "bbqs:Investigator", "https://schema.org/author"),
    ],
    instancesFrom: [{ label: "Announcements", path: "/announcements" }],
  },

  // ---- JobPosting
  {
    key: "bbqs:Job",
    label: "bbqs:Job",
    description: "A postdoc, staff, or trainee position posted by a BBQS lab.",
    parent: "schema:JobPosting",
    subClassOf: "https://schema.org/JobPosting",
    properties: [
      P("title", "Text", "https://schema.org/title"),
      P("hiringOrganization", "bbqs:ResearchOrganization", "https://schema.org/hiringOrganization"),
      P("employmentType", "Text", "https://schema.org/employmentType"),
      P("datePosted", "Date", "https://schema.org/datePosted"),
    ],
    instancesFrom: [{ label: "Job Board", path: "/jobs" }],
  },

  // ---- Taxon
  {
    key: "bbqs:Species",
    label: "bbqs:Species",
    description: "A species studied in a BBQS project.",
    parent: "schema:Taxon",
    subClassOf: "https://schema.org/Taxon",
    properties: [
      P("name", "Text", "https://schema.org/name"),
      P("taxonRank", "Text", "https://schema.org/taxonRank"),
      P("identifier", "URL", "https://schema.org/identifier", "NCBI Taxon URL."),
    ],
    instancesFrom: [{ label: "Species", path: "/species" }],
    examples: ["Human", "Mouse (Mus musculus)", "Zebrafish"],
  },

  // ---- Devices
  {
    key: "bbqs:Device",
    label: "bbqs:Device",
    description: "A scientific instrument used in BBQS data collection. Specialized by modality.",
    parent: "schema:Product",
    subClassOf: "https://schema.org/Product",
    properties: [
      P("name", "Text", "https://schema.org/name"),
      P("manufacturer", "Text", "https://schema.org/manufacturer"),
      P("model", "Text", "https://schema.org/model"),
      P("category", "Text", "https://schema.org/category", "BBQS canonical category (1 of 32)."),
    ],
    instancesFrom: [{ label: "Devices", path: "/devices" }],
  },
  {
    key: "bbqs:NeuralRecordingDevice",
    label: "bbqs:NeuralRecordingDevice",
    description: "Devices that record neural activity directly.",
    parent: "bbqs:Device",
    properties: [
      P("channelCount", "Integer", undefined, "Number of recording channels."),
      P("samplingRate", "Quantity", undefined, "Hz."),
    ],
    examples: ["Neuropixels", "Wireless neural headstage", "iEEG/ECoG", "EEG", "Optically pumped magnetometers"],
  },
  {
    key: "bbqs:BehavioralSensor",
    label: "bbqs:BehavioralSensor",
    description: "Devices capturing behavior — video, pose, gaze, movement.",
    parent: "bbqs:Device",
    properties: [P("frameRate", "Quantity", undefined, "fps.")],
    examples: ["Video cameras", "Thermal cameras", "IR cameras", "Motion capture", "Eye tracker", "IMU", "Smartphone camera"],
  },
  {
    key: "bbqs:PhysiologicalSensor",
    label: "bbqs:PhysiologicalSensor",
    description: "Devices measuring peripheral physiology.",
    parent: "bbqs:Device",
    properties: [P("samplingRate", "Quantity", undefined, "Hz.")],
    examples: ["EDA", "ECG / heart rate", "EMG", "PPG / pulse oximetry", "Respiration belt", "Cortisol wearable", "Skin temperature"],
  },
  {
    key: "bbqs:EnvironmentalSensor",
    label: "bbqs:EnvironmentalSensor",
    description: "Devices sensing the environment or spatial context around a subject.",
    parent: "bbqs:Device",
    properties: [],
    examples: ["LiDAR", "mmWave radar", "GPS", "RFID", "Flow sensors", "Ultrasonic microphones"],
  },
  {
    key: "bbqs:ImagingSystem",
    label: "bbqs:ImagingSystem",
    description: "Large-scale imaging systems.",
    parent: "bbqs:Device",
    properties: [P("modality", "Text", undefined, "fMRI, two-photon, thermal.")],
    examples: ["fMRI scanner", "Two-photon microscope"],
  },

  // ---- Event
  {
    key: "bbqs:WorkshopEvent",
    label: "bbqs:WorkshopEvent",
    description: "A BBQS-organized workshop or convening.",
    parent: "schema:Event",
    subClassOf: "https://schema.org/Event",
    properties: [
      P("name", "Text", "https://schema.org/name"),
      P("startDate", "Date", "https://schema.org/startDate"),
      P("endDate", "Date", "https://schema.org/endDate"),
      P("location", "Text", "https://schema.org/location"),
      P("attendee", "bbqs:Investigator", "https://schema.org/attendee"),
    ],
    instancesFrom: [
      { label: "MIT Workshop 2026", path: "/mit-workshop-2026" },
      { label: "SFN 2025", path: "/sfn-2025" },
    ],
  },
];

export const ALL_TYPES: BbqsType[] = [...SCHEMA_ROOTS, ...BBQS_TYPES];

export function findType(key: string): BbqsType | undefined {
  return ALL_TYPES.find((t) => t.key === key);
}

export function childrenOf(key: string): BbqsType[] {
  return ALL_TYPES.filter((t) => t.parent === key);
}

export function buildJsonLdExample(type: BbqsType): Record<string, unknown> {
  const schemaType = type.subClassOf?.replace("https://schema.org/", "") ?? "Thing";
  const obj: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": schemaType,
    // Must stay identical to the `bbqs:` prefix in public/bbqs-schema.linkml.yaml — the two
    // are the same namespace, and a mismatch silently mints two identifiers per type.
    "@id": `https://brain-bbqs.org/schema#${type.key}`,
  };
  for (const p of type.properties.slice(0, 5)) {
    obj[p.name] = `<${p.expectedType}>`;
  }
  return obj;
}