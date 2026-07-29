import { McpServer, StreamableHttpTransport } from "npm:mcp-lite@^0.10.0";
import { Hono } from "npm:hono@^4.9.7";
import { searchProjects, listSpecies, type KgAuth } from "../_shared/kg.ts";
import { askKG } from "../_shared/rag.ts";

// BBQS MCP server — feature 009 (one data truth: live KG, anon).
// All tools read the LIVE KG via the shared anon layer; no static MARR_PROJECTS, no service
// role, no ontology. Public consortium data only (RLS is the authority).
const AUTH: KgAuth = { anon: true };

// ─── MCP Server ───────────────────────────────────────────
const mcp = new McpServer({
  name: "bbqs-mcp",
  version: "2.0.0",
});

// Tool: search_projects
mcp.tool("search_projects", {
  description:
    "Search BBQS consortium projects by species, PI name, or free-text query. Returns live project metadata (grant_number, title, abstract snippet, study species, keywords, investigators). Free-text uses semantic search over the knowledge graph.",
  parameters: {
    type: "object" as const,
    properties: {
      species: { type: "string", description: "Filter by species (e.g. Mouse, Zebrafish, Drosophila)" },
      pi: { type: "string", description: "Filter by principal investigator name" },
      query: { type: "string", description: "Free-text semantic search across projects" },
    },
  },
  handler: async (args: { species?: string; pi?: string; query?: string }) => {
    const result = await searchProjects(
      { species: args.species, pi: args.pi, query: args.query },
      AUTH,
    );
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
});

// Tool: list_species
mcp.tool("list_species", {
  description:
    "List all species studied across the BBQS consortium with project counts and associated project titles.",
  parameters: { type: "object" as const, properties: {} },
  handler: async () => {
    const result = await listSpecies(AUTH);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
});

// Tool: ask_bbqs
mcp.tool("ask_bbqs", {
  description:
    "Ask a natural-language question about the BBQS consortium. Retrieval-augmented over the knowledge base (projects, publications, investigators, resources). Answers only from retrieved context; says so when it finds nothing.",
  parameters: {
    type: "object" as const,
    properties: {
      question: { type: "string", description: "The question to ask about BBQS" },
    },
    required: ["question"],
  },
  handler: async (args: { question: string }) => {
    const { answer, sources } = await askKG(args.question, AUTH);
    const srcLine = sources.length ? sources.map((s) => `[${s.type}] ${s.title}`).join(", ") : "none";
    return { content: [{ type: "text" as const, text: `${answer}\n\nSources: ${srcLine}` }] };
  },
});

// ─── HTTP Transport ───────────────────────────────────────
// mcp-lite 0.10: bind the transport to the server → returns the HTTP handler.
// (The prior code called handleRequest(req, mcp) without binding → "Transport not
// bound to a server" 500 on every protocol request; the MCP endpoint never worked.)
const transport = new StreamableHttpTransport();
const mcpHandler = transport.bind(mcp);

const app = new Hono();
const mcpApp = new Hono();

mcpApp.get("/", (c) => {
  return c.json({
    name: "bbqs-mcp",
    version: "2.0.0",
    description: "BBQS Consortium MCP Server — query live projects, species, and ask questions via RAG over the knowledge graph.",
    tools: ["search_projects", "list_species", "ask_bbqs"],
  });
});

mcpApp.all("/*", async (c) => {
  try {
    return await mcpHandler(c.req.raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[bbqs-mcp] transport error:", msg, e instanceof Error ? e.stack : "");
    return c.json({ error: "MCP transport error", detail: msg }, 500);
  }
});

app.route("/bbqs-mcp", mcpApp);

Deno.serve(app.fetch);
