import { Link } from "react-router-dom";
import { PageMeta } from "@/components/PageMeta";
import { Terminal, Plug, ChevronRight, ArrowRight, Globe, Settings, Play, Search, Layers, Database, MessageSquare, BookOpen, Code } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CodeBlock } from "@/components/api-docs/CodeBlock";
import { StepCard } from "@/components/api-docs/StepCard";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const MCP_URL = `${SUPABASE_URL}/functions/v1/bbqs-mcp/mcp`;

// Public tools — usable with no account. Signing in unlocks member self-service (edit your
// profile, request working groups) and, for curators, onboarding/offboarding. The client is
// prompted to sign in the first time it calls one of those; see the auth note below.
const mcpTools = [
  { name: "search_projects", description: "Search projects by species, PI, or free-text query.", params: ["species", "pi", "query"], icon: Search },
  { name: "list_species", description: "List all species with project counts and associated project names.", params: [], icon: Database },
  { name: "ask_bbqs", description: "Ask a natural-language question using RAG over the BBQS knowledge base.", params: ["question"], icon: MessageSquare },
];

const claudeConfig = `{
  "mcpServers": {
    "bbqs": {
      "url": "${SUPABASE_URL}/functions/v1/bbqs-mcp/mcp"
    }
  }
}`;

const cursorConfig = `{
  "name": "bbqs",
  "transport": "streamable-http",
  "url": "${SUPABASE_URL}/functions/v1/bbqs-mcp/mcp"
}`;

export default function McpDocs() {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageMeta title="MCP Server" description="Connect BBQS as a native MCP tool provider to Claude, Cursor, Windsurf, and other AI agents." />
      {/* Header — formal, minimal */}
      <div className="mb-8 border-b-2 border-border pb-6">
        <div className="flex items-center gap-3 mb-2">
          <Plug className="h-6 w-6 text-foreground" />
          <h1 className="text-2xl font-bold text-foreground tracking-tight">BBQS MCP Server Documentation</h1>
        </div>
        <p className="text-sm text-muted-foreground max-w-3xl leading-relaxed">
          Connect BBQS as a native tool provider to AI agents. The MCP server exposes structured tools that Claude, Cursor, Windsurf, and other MCP-compatible clients can call directly — no custom code needed.
        </p>
      </div>

      {/* MCP URL */}
      <div className="mb-8 border border-border rounded-lg p-4 bg-muted/30">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
          <Globe className="h-3.5 w-3.5" /> MCP Server URL
        </h3>
        <CodeBlock code={MCP_URL} />
        <p className="text-xs text-muted-foreground mt-2">Use this URL when configuring any MCP client. The public tools work with no account; the client will prompt you to sign in with BBQS (OAuth) the first time it calls a member or curator tool.</p>
      </div>

      {/* Available Tools */}
      <div className="mb-8">
        <h2 className="text-lg font-bold text-foreground mb-1 flex items-center gap-2">
          <BookOpen className="h-4.5 w-4.5 text-muted-foreground" />
          Available Tools
        </h2>
        <p className="text-xs text-muted-foreground mb-4">These tools are automatically discovered by MCP clients when they connect to the server.</p>
        <div className="space-y-3">
          {mcpTools.map((tool) => (
            <div key={tool.name} className="border border-border rounded-lg p-4 bg-card">
              <div className="flex items-center gap-2 mb-2">
                <tool.icon className="h-4 w-4 text-muted-foreground" />
                <code className="text-xs font-mono font-bold text-foreground">{tool.name}</code>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{tool.description}</p>
              {tool.params.length > 0 && (
                <div className="flex gap-1.5 mt-2 flex-wrap">
                  {tool.params.map(p => (
                    <Badge key={p} variant="outline" className="text-[10px] font-mono border-border">{p}</Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ─── SETUP GUIDES ─── */}
      <div className="mb-6">
        <h2 className="text-lg font-bold text-foreground mb-1 flex items-center gap-2">
          <Settings className="h-4.5 w-4.5 text-muted-foreground" />
          Setup Guides
        </h2>
        <p className="text-xs text-muted-foreground">Step-by-step instructions for connecting BBQS to your AI tool of choice.</p>
      </div>

      {/* Claude Desktop */}
      <div className="mb-5 border border-border rounded-lg overflow-hidden">
        <div className="px-5 py-3 bg-muted/40 border-b border-border">
          <h4 className="text-sm font-bold text-foreground">Claude Desktop</h4>
        </div>
        <div className="px-5 py-5 bg-card space-y-0">
          <StepCard number={1} color="bg-primary" step={{
            title: "Open Claude Desktop settings",
            description: "Click the Claude menu in your menu bar → Settings → Developer → Edit Config.",
            detail: "On macOS, the config file is at ~/Library/Application Support/Claude/claude_desktop_config.json"
          }} />
          <StepCard number={2} color="bg-primary" step={{
            title: "Add the BBQS MCP server config",
            description: "Paste the JSON below into your claude_desktop_config.json file.",
          }} />
          <div className="ml-12 mb-4">
            <CodeBlock code={claudeConfig} language="json" />
          </div>
          <StepCard number={3} color="bg-primary" step={{
            title: "Restart Claude Desktop",
            description: "Fully quit and reopen Claude Desktop. You should see a hammer 🔨 icon in the chat input — click it to verify the BBQS tools are listed.",
            detail: "You'll see search_projects, list_species, and ask_bbqs in the tools list."
          }} />
          <StepCard number={4} color="bg-primary" step={{
            title: "Start asking questions!",
            description: "Try: \"Use BBQS to find all projects studying zebrafish\" or \"What pose estimation tools do BBQS projects use?\"",
          }} />
        </div>
      </div>

      {/* Cursor */}
      <div className="mb-5 border border-border rounded-lg overflow-hidden">
        <div className="px-5 py-3 bg-muted/40 border-b border-border">
          <h4 className="text-sm font-bold text-foreground">Cursor</h4>
        </div>
        <div className="px-5 py-5 bg-card space-y-0">
          <StepCard number={1} color="bg-primary" step={{
            title: "Open Cursor Settings",
            description: "Go to Cursor → Settings → MCP Servers (or press Cmd+Shift+P → \"MCP: Add Server\").",
          }} />
          <StepCard number={2} color="bg-primary" step={{
            title: "Add a new MCP server",
            description: "Click \"+ Add Server\" and paste the config below. Select \"Streamable HTTP\" as the transport type.",
          }} />
          <div className="ml-12 mb-4">
            <CodeBlock code={cursorConfig} language="json" />
          </div>
          <StepCard number={3} color="bg-primary" step={{
            title: "Verify the connection",
            description: "The BBQS tools should appear in the MCP panel. You can now reference them in your Cursor chat with @bbqs.",
          }} />
        </div>
      </div>

      {/* Windsurf & Generic */}
      <div className="mb-5 border border-border rounded-lg overflow-hidden">
        <div className="px-5 py-3 bg-muted/40 border-b border-border">
          <h4 className="text-sm font-bold text-foreground">Windsurf & Other MCP Clients</h4>
        </div>
        <div className="px-5 py-5 bg-card space-y-0">
          <StepCard number={1} color="bg-primary" step={{
            title: "Find the MCP settings in your client",
            description: "Most MCP-compatible tools have a configuration file or UI for adding MCP servers.",
          }} />
          <StepCard number={2} color="bg-primary" step={{
            title: "Configure the server URL",
            description: `Point your MCP client to the BBQS MCP URL. Use "streamable-http" as the transport type if your client asks.`,
          }} />
          <div className="ml-12 mb-4">
            <CodeBlock code={MCP_URL} />
          </div>
          <StepCard number={3} color="bg-primary" step={{
            title: "That's it!",
            description: "The MCP server auto-advertises its tools. Your client will discover search_projects, list_species, and ask_bbqs automatically.",
          }} />
        </div>
      </div>

      {/* Testing with Inspector */}
      <div className="mb-8 border border-border rounded-lg overflow-hidden">
        <div className="px-5 py-3 bg-muted/40 border-b border-border">
          <h4 className="text-sm font-bold text-foreground flex items-center gap-2">
            <Play className="h-4 w-4 text-muted-foreground" />
            Test with MCP Inspector
          </h4>
          <p className="text-xs text-muted-foreground mt-1">Verify the server works before connecting to your AI tool.</p>
        </div>
        <div className="px-5 py-5 bg-card space-y-0">
          <StepCard number={1} color="bg-primary" step={{
            title: "Run the MCP Inspector",
            description: "Open a terminal and run the command below.",
          }} />
          <div className="ml-12 mb-4">
            <CodeBlock code="npx @modelcontextprotocol/inspector" />
          </div>
          <StepCard number={2} color="bg-primary" step={{
            title: "Enter the BBQS MCP URL",
            description: "In the Inspector UI, select \"Streamable HTTP\" transport and paste the MCP URL. Click Connect.",
          }} />
          <div className="ml-12 mb-4">
            <CodeBlock code={MCP_URL} />
          </div>
          <StepCard number={3} color="bg-primary" step={{
            title: "Browse and test tools",
            description: "Click \"List Tools\" to see all available BBQS tools. Select any tool, fill in test parameters, and click \"Call Tool\" to see the response.",
            detail: "Try calling search_projects with species=\"Mouse\" to verify everything works end-to-end."
          }} />
        </div>
      </div>

      {/* Usage Notes */}
      <div className="mb-10 border border-border rounded-lg p-5 bg-muted/20">
        <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          Technical Notes
        </h3>
        <ul className="text-xs text-muted-foreground space-y-2">
          {[
            "Uses Streamable HTTP transport — no SSE, WebSocket, or stdio required",
            "Tools are auto-discovered by MCP clients via the standard tools/list method",
            "The ask_bbqs tool uses RAG with vector embeddings for grounded answers",
            "All tool responses follow the MCP content format (text/content array)",
            "Server is rate-limited to prevent abuse",
            "No authentication required — the server is publicly accessible",
          ].map((note, i) => (
            <li key={i} className="flex items-start gap-2">
              <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Link to REST API */}
      <Link
        to="/api-docs"
        className="block border border-border rounded-lg p-4 bg-muted/20 hover:bg-muted/40 transition-colors group"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Code className="h-5 w-5 text-muted-foreground" />
            <div>
              <h3 className="text-sm font-semibold text-foreground">REST API Reference</h3>
              <p className="text-xs text-muted-foreground">Query BBQS data with standard HTTP endpoints — curl, fetch, Postman</p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
        </div>
      </Link>
    </div>
  );
}
