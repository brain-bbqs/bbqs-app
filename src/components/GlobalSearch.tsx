import { useState, useRef, useEffect, useMemo } from "react";
import { Search, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

interface SearchablePage {
  title: string;
  path: string;
  keywords: string[];
  section: string;
}

const PAGES: SearchablePage[] = [
  { title: "Home", path: "/", keywords: ["home", "dashboard", "overview", "bbqs", "brain", "behavior"], section: "General" },
  { title: "About", path: "/about", keywords: ["about", "mission", "consortium", "overview"], section: "General" },
  
  { title: "Projects", path: "/projects", keywords: ["projects", "grants", "research", "labs", "marr", "nih", "r34", "r61", "u01"], section: "Knowledge Base" },
  { title: "Publications", path: "/publications", keywords: ["publications", "papers", "journals", "articles", "doi", "pubmed"], section: "Knowledge Base" },

  { title: "Software", path: "/resources", keywords: ["software", "tools", "deeplabcut", "sleap", "simba", "bonsai", "openpose", "anipose", "idtracker", "resources"], section: "Tools" },
  { title: "Datasets", path: "/datasets", keywords: ["datasets", "data", "training", "superanimal", "quadruped", "mouse"], section: "Tools" },
  { title: "Benchmarks", path: "/benchmarks", keywords: ["benchmarks", "evaluation", "leaderboard", "metrics", "accuracy"], section: "Tools" },
  { title: "ML Models", path: "/ml-models", keywords: ["ml", "models", "machine learning", "cebra", "model zoo", "huggingface"], section: "Tools" },
  { title: "Protocols", path: "/protocols", keywords: ["protocols", "methods", "3d pose", "methodology"], section: "Tools" },

  { title: "Species", path: "/species", keywords: ["species", "mouse", "rat", "primate", "fish", "fly", "drosophila", "zebrafish", "bird"], section: "Science" },

  { title: "Principal Investigators", path: "/investigators", keywords: ["investigators", "pi", "principal", "researchers", "faculty", "people"], section: "Community" },
  { title: "Working Groups", path: "/working-groups", keywords: ["working", "groups", "committees", "teams"], section: "Community" },
  { title: "Announcements", path: "/announcements", keywords: ["announcements", "news", "updates"], section: "Community" },

  { title: "SFN 2026", path: "/sfn-2026", keywords: ["sfn", "2026", "conference", "neuroscience", "poster"], section: "Conferences" },
  { title: "SFN 2025", path: "/sfn-2025", keywords: ["sfn", "2025", "conference", "neuroscience", "poster"], section: "Conferences" },

  { title: "Data Sharing Policy", path: "/data-sharing-policy", keywords: ["data", "sharing", "policy", "legal", "compliance"], section: "Documentation" },
  { title: "API Reference", path: "/api-docs", keywords: ["api", "rest", "endpoints", "curl", "fetch", "documentation"], section: "Documentation" },
  { title: "MCP Server Docs", path: "/mcp-docs", keywords: ["mcp", "server", "claude", "cursor", "model", "context", "protocol"], section: "Documentation" },
  { title: "Build MCP Server", path: "/mcp-tutorial", keywords: ["build", "mcp", "tutorial", "python", "fastmcp", "deploy"], section: "Documentation" },

  { title: "Roadmap", path: "/roadmap", keywords: ["roadmap", "timeline", "milestones", "planning", "github"], section: "Development" },
  { title: "Software Architecture", path: "/design-docs", keywords: ["software", "architecture", "design", "system", "technical"], section: "Development" },
  { title: "Agentic Framework", path: "/agentic-framework", keywords: ["agentic", "framework", "workflow", "agents", "ai"], section: "Development" },
];

export function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase().trim();
    return PAGES.filter(page =>
      page.title.toLowerCase().includes(q) ||
      page.keywords.some(k => k.includes(q)) ||
      page.section.toLowerCase().includes(q)
    ).slice(0, 8);
  }, [query]);

  const showDropdown = focused && query.trim().length > 0;

  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ⌘K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleSelect = (path: string) => {
    navigate(path);
    setQuery("");
    setFocused(false);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[selectedIndex]) {
      handleSelect(results[selectedIndex].path);
    } else if (e.key === "Escape") {
      setFocused(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div ref={containerRef} className="relative w-full max-w-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-muted/50 border border-border rounded-lg">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search pages..."
          className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
        />
        <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono bg-background border border-border rounded text-muted-foreground">
          ⌘K
        </kbd>
      </div>

      {/* Dropdown results */}
      {showDropdown && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-lg overflow-hidden z-50">
          {results.length === 0 ? (
            <div className="px-4 py-3 text-center">
              <p className="text-xs text-muted-foreground">No pages found for "{query}"</p>
            </div>
          ) : (
            <div className="py-1">
              {results.map((page, i) => (
                <button
                  key={page.path}
                  onClick={() => handleSelect(page.path)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={cn(
                    "w-full flex items-center justify-between px-3 py-2 text-left transition-colors",
                    i === selectedIndex ? "bg-muted" : "hover:bg-muted/50"
                  )}
                >
                  <div>
                    <p className="text-sm font-medium text-foreground">{page.title}</p>
                    <p className="text-[11px] text-muted-foreground">{page.section}</p>
                  </div>
                  <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
