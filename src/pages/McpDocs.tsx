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
  { name: "list_funding_opportunities", description: "Funding opportunities BBQS tracks: number, title, status, dates and link.", params: ["status", "limit"], icon: BookOpen },
];

const cursorConfig = `{
  "name": "bbqs",
  "transport": "streamable-http",
  "url": "${SUPABASE_URL}/functions/v1/bbqs-mcp/mcp"
}`;

// The CLI doesn't depend on a managed org allowing custom connectors, so anyone at any institution
// can self-connect this way.
const cliAdd = `claude mcp add --scope user --transport http bbqs ${SUPABASE_URL}/functions/v1/bbqs-mcp/mcp`;

export default function McpDocs() {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageMeta title="MCP Server" description="Connect BBQS as a native MCP tool provider to Claude, Cursor, Windsurf, and other AI agents." />
      {/* Header — formal, minimal */}
      <div className="mb-8 border-b-2 border-border pb-6">
        <div className="flex items-center gap-3 mb-2">
          <img src="/brand/bbqs-mcp-icon.svg" alt="" className="h-9 w-9" />
          <h1 className="text-2xl font-bold text-foreground tracking-tight">BBQS MCP Server</h1>
        </div>
        <p className="text-sm text-muted-foreground max-w-3xl leading-relaxed">
          Connect BBQS to Claude and other AI assistants. The MCP server gives them structured tools for the BBQS knowledge graph: search projects and species, ask questions, and (once you sign in) manage your own profile.
        </p>
      </div>

      {/* MCP URL — everything below needs only this */}
      <div className="mb-8 border border-border rounded-lg p-4 bg-muted/30">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
          <Globe className="h-3.5 w-3.5" /> Server URL
        </h3>
        <CodeBlock code={MCP_URL} />
        <p className="text-xs text-muted-foreground mt-2">
          Paste this into your client's connector settings. Opening it in a browser shows "Bad Request"; that's expected, it isn't a web page.
          Public tools work with no account. The first time you use a tool that needs an account, your client asks you to sign in with BBQS (your institutional login).
        </p>
      </div>

      {/* Claude — one connector for web, desktop, mobile and Claude Code */}
      <div className="mb-5 border border-primary/40 rounded-lg overflow-hidden">
        <div className="px-5 py-3 bg-primary/5 border-b border-border">
          <h4 className="text-sm font-bold text-foreground flex items-center gap-2"><Plug className="h-4 w-4" /> Claude (claude.ai, Desktop, mobile)</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Add it once and it's available everywhere you use Claude with that account, including Claude Code.
          </p>
        </div>
        <div className="px-5 py-5 bg-card space-y-0">
          <StepCard number={1} color="bg-primary" step={{
            title: "Open Customize → Connectors",
            description: "In claude.ai or the Claude desktop app, open Customize, then Connectors, and click \"Add custom connector\".",
          }} />
          <StepCard number={2} color="bg-primary" step={{
            title: "Paste the server URL",
            description: "Name it BBQS, paste the URL above, and click Add.",
          }} />
          <StepCard number={3} color="bg-primary" step={{
            title: "Connect and sign in",
            description: "Open the BBQS connector and click Connect. When asked, sign in with your institutional login and approve BBQS.",
            detail: "Free plans allow one custom connector. On a Team or Enterprise plan, only an organization Owner can add custom connectors (Organization settings → Connectors → Add → Custom). Ask yours to add BBQS once for everyone, and then each member just clicks Connect.",
          }} />
          <StepCard number={4} color="bg-primary" step={{
            title: "Ask away",
            description: "Try: \"Use BBQS to find all projects studying zebrafish\" or \"What species does BBQS study?\"",
          }} />
        </div>
      </div>

      {/* Claude Code — works without any org permission */}
      <div className="mb-8 border border-border rounded-lg overflow-hidden">
        <div className="px-5 py-3 bg-muted/40 border-b border-border">
          <h4 className="text-sm font-bold text-foreground flex items-center gap-2"><Terminal className="h-4 w-4" /> Claude Code</h4>
          <p className="text-xs text-muted-foreground mt-1">
            If you added the connector above, Claude Code already has it, on the web too. Otherwise, this one command works from any institution with no admin approval.
          </p>
        </div>
        <div className="px-5 py-5 bg-card space-y-0">
          <StepCard number={1} color="bg-primary" step={{
            title: "Add the server",
            description: "Run this in your terminal.",
          }} />
          <div className="ml-12 mb-4">
            <CodeBlock code={cliAdd} language="bash" />
          </div>
          <StepCard number={2} color="bg-primary" step={{
            title: "Sign in",
            description: "Open Claude Code, run /mcp, select bbqs and choose Authenticate.",
            detail: "Claude Code has file and shell access, so use a new, empty folder rather than a code project when you work with BBQS tools.",
          }} />
        </div>
      </div>

      {/* Available Tools */}
      <div className="mb-8">
        <h2 className="text-lg font-bold text-foreground mb-1 flex items-center gap-2">
          <BookOpen className="h-4.5 w-4.5 text-muted-foreground" />
          Available Tools
        </h2>
        <p className="text-xs text-muted-foreground mb-4">
          Public tools, usable with no account. Signed-in members can also view their onboarding status, edit their own profile and request working groups; curators get the onboarding tools.
        </p>
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
        <p className="text-xs text-muted-foreground">For other MCP clients.</p>
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
            "Public tools need no account. Member and curator tools use OAuth 2.1: the server asks your client to sign in only when you call one, and every action is recorded under your own account",
            "The server acts with your own BBQS access and no more; it holds no admin key",
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
