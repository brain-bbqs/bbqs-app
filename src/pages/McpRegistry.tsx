import { useState } from "react";
import { PageMeta } from "@/components/PageMeta";
import { Plug, Plus, Globe, Package, Search, ChevronRight, Github, Check, Clock, BookOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";
import { CodeBlock } from "@/components/api-docs/CodeBlock";

interface McpServer {
  id: string;
  name: string;
  description: string;
  author: string;
  url: string;
  transport: string;
  tools: string[];
  species: string[];
  status: string;
  github_url: string | null;
  pip_package: string | null;
}

function ServerCard({ server }: { server: McpServer }) {
  const configSnippet = `{
  "mcpServers": {
    "${server.name.toLowerCase().replace(/\s+/g, "-")}": {
      "url": "${server.url}"
    }
  }
}`;
  const [showConfig, setShowConfig] = useState(false);

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="px-5 py-3 bg-muted/40 border-b border-border">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              {server.name}
              {server.status === "approved" && (
                <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">
                  <Check className="h-2.5 w-2.5 mr-0.5" /> Verified
                </Badge>
              )}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">by {server.author}</p>
          </div>
          <div className="flex gap-1.5">
            {server.github_url && (
              <a href={server.github_url} target="_blank" rel="noopener noreferrer" className="w-7 h-7 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
                <Github className="h-3.5 w-3.5" />
              </a>
            )}
            {server.pip_package && (
              <Badge variant="outline" className="text-[10px] font-mono h-7 flex items-center">
                <Package className="h-3 w-3 mr-1" /> {server.pip_package}
              </Badge>
            )}
          </div>
        </div>
      </div>
      <div className="px-5 py-4 bg-card">
        <p className="text-xs text-muted-foreground leading-relaxed mb-3">{server.description}</p>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {server.tools.map(tool => (
            <Badge key={tool} variant="outline" className="text-[10px] font-mono border-border">{tool}</Badge>
          ))}
        </div>
        {server.species.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {server.species.map(s => (
              <Badge key={s} variant="outline" className="text-[10px] border-border">{s}</Badge>
            ))}
          </div>
        )}
        <button
          onClick={() => setShowConfig(!showConfig)}
          className="text-xs text-muted-foreground hover:text-foreground font-semibold flex items-center gap-1 transition-colors"
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", showConfig && "rotate-90")} />
          {showConfig ? "Hide" : "Show"} connection config
        </button>
        {showConfig && (
          <div className="mt-2">
            <CodeBlock code={configSnippet} language="json" />
          </div>
        )}
      </div>
    </div>
  );
}

export default function McpRegistry() {
  const officialServer: McpServer = {
    id: "bbqs-official",
    name: "BBQS Official",
    description: "The official BBQS MCP server — search projects, explore Marr-level ontology, list species, and ask AI-powered questions about the consortium.",
    author: "BBQS Consortium",
    url: `${import.meta.env.VITE_SUPABASE_URL || ""}/functions/v1/bbqs-mcp/mcp`,
    transport: "streamable-http",
    tools: ["search_projects", "list_species", "ask_bbqs"],
    species: [],
    status: "approved",
    github_url: null,
    pip_package: null,
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageMeta title="MCP Registry" description="Community directory of MCP servers for the BBQS neuroscience ecosystem." />
      <div className="mb-8 border-b-2 border-border pb-6">
        <div className="flex items-center gap-3 mb-2">
          <Plug className="h-6 w-6 text-foreground" />
          <h1 className="text-2xl font-bold text-foreground tracking-tight">MCP Server Registry</h1>
        </div>
        <p className="text-sm text-muted-foreground max-w-3xl leading-relaxed">
          Directory of MCP servers for the BBQS ecosystem. Connect them to Claude, Cursor, or any MCP-compatible AI agent to extend neuroscience workflows.
        </p>
      </div>

      <div className="flex items-center justify-between mb-6">
        <p className="text-xs text-muted-foreground">1 server registered</p>
        <Link to="/mcp-tutorial">
          <Button variant="outline" size="sm" className="text-xs">
            <Package className="h-3.5 w-3.5 mr-1" /> Build Your Own
          </Button>
        </Link>
      </div>

      <div className="space-y-4">
        <ServerCard server={officialServer} />
      </div>

      <div className="mt-10">
        <Link
          to="/mcp-docs"
          className="block border border-border rounded-lg p-4 bg-muted/20 hover:bg-muted/40 transition-colors group"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Plug className="h-5 w-5 text-muted-foreground" />
              <div>
                <h3 className="text-sm font-semibold text-foreground">BBQS MCP Server Documentation</h3>
                <p className="text-xs text-muted-foreground">Connect to the official BBQS MCP server</p>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
          </div>
        </Link>
      </div>
    </div>
  );
}
