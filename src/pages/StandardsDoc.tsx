import { useEffect } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Element, ElementContent } from "hast";
import { BookOpen, ChevronRight, ExternalLink, Github } from "lucide-react";
import { PageMeta } from "@/components/PageMeta";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  STANDARDS_BASE_PATH,
  STANDARDS_REPO_URL,
  getStandardsDoc,
  headingId,
  resolveDocUrl,
  standardsDocs,
} from "@/lib/standardsDocs";

function nodeText(node: ElementContent | Element | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map(nodeText).join("");
  return "";
}

/** ## and ### headings of a document, for the table of contents. */
function outline(markdown: string) {
  const headings: { level: number; text: string; id: string }[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = !inFence && line.match(/^(#{2,3})\s+(.*?)\s*#*$/);
    if (!match) continue;
    const text = match[2]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .replace(/\\(.)/g, "$1");
    headings.push({ level: match[1].length, text, id: headingId(text) });
  }
  return headings;
}

function Breadcrumb({ current }: { current?: string }) {
  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-4">
      <Link to="/working-groups" className="hover:text-foreground">Working Groups</Link>
      <ChevronRight className="h-3.5 w-3.5" />
      {current ? (
        <>
          <Link to={STANDARDS_BASE_PATH} className="hover:text-foreground">Standards</Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="text-foreground">{current}</span>
        </>
      ) : (
        <span className="text-foreground">Standards</span>
      )}
    </nav>
  );
}

function Unavailable() {
  return (
    <p className="text-sm text-muted-foreground">
      The WG-Standards documents are not available in this build. Read them on{" "}
      <a href={STANDARDS_REPO_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
        GitHub
      </a>
      .
    </p>
  );
}

/** /working-groups/standards — lists the documents. */
export function StandardsDocsIndex() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <PageMeta
        title="WG-Standards Documents"
        description="Guidelines and charter of the BBQS Working Group on Data Standards"
      />
      <Breadcrumb />
      <div className="flex items-center gap-3 mb-6">
        <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <BookOpen className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">WG-Standards Documents</h1>
          <p className="text-sm text-muted-foreground">
            Maintained by the BBQS Working Group on Data Standards in{" "}
            <a href={STANDARDS_REPO_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              brain-bbqs/bbqs-standards
            </a>
          </p>
        </div>
      </div>
      {standardsDocs.length === 0 ? (
        <Unavailable />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {standardsDocs.map((doc) => (
            <Link key={doc.slug} to={`${STANDARDS_BASE_PATH}/${doc.slug}`}>
              <Card className="h-full hover:shadow-lg hover:border-primary/40 transition-all">
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg">{doc.shortTitle}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{doc.description}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** /working-groups/standards/:slug — renders one document. */
export default function StandardsDoc() {
  const { slug } = useParams();
  const { hash } = useLocation();
  const doc = getStandardsDoc(slug);

  // The browser tries to scroll to #anchor before React has rendered the document.
  useEffect(() => {
    if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [hash, doc]);

  if (!doc) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-8">
        <Breadcrumb current={slug} />
        {standardsDocs.length === 0 ? (
          <Unavailable />
        ) : (
          <p className="text-sm text-muted-foreground">
            No document named “{slug}”. See the{" "}
            <Link to={STANDARDS_BASE_PATH} className="text-primary hover:underline">list of documents</Link>.
          </p>
        )}
      </div>
    );
  }

  const toc = outline(doc.body);
  const heading =
    (Tag: "h2" | "h3" | "h4"): Components[typeof Tag] =>
    ({ node, children, ...props }) => (
      <Tag id={headingId(nodeText(node))} className="scroll-mt-24" {...props}>
        {children}
      </Tag>
    );

  const components: Components = {
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    a: ({ node, href = "", children, ...props }) =>
      href.startsWith("/") ? (
        <Link to={href} {...props}>{children}</Link>
      ) : href.startsWith("#") ? (
        <a href={href} {...props}>{children}</a>
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
      ),
    img: ({ node, ...props }) => (
      <img {...props} loading="lazy" className="mx-auto rounded-lg border border-border bg-white" />
    ),
    table: ({ node, ...props }) => (
      <div className="overflow-x-auto">
        <table {...props} />
      </div>
    ),
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <PageMeta title={doc.shortTitle} description={doc.description || doc.title} />
      <Breadcrumb current={doc.shortTitle} />
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-10">
        <article className="min-w-0">
          <h1 className="text-3xl font-bold text-foreground mb-2">{doc.title}</h1>
          <a
            href={doc.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary mb-8"
          >
            <Github className="h-4 w-4" />
            View source or suggest a change on GitHub
            <ExternalLink className="h-3 w-3" />
          </a>
          <div className="prose prose-slate dark:prose-invert max-w-none prose-headings:scroll-mt-24 prose-a:text-primary">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              urlTransform={(url) => defaultUrlTransform(resolveDocUrl(doc.slug, url))}
              components={components}
            >
              {doc.body}
            </ReactMarkdown>
          </div>
        </article>
        {toc.length > 0 && (
          <aside className="hidden lg:block">
            <nav className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto text-sm">
              <p className="font-semibold text-foreground mb-2">On this page</p>
              <ul className="space-y-1.5">
                {toc.map((h) => (
                  <li key={h.id} className={h.level === 3 ? "pl-3" : ""}>
                    <a href={`#${h.id}`} className="text-muted-foreground hover:text-primary">
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>
        )}
      </div>
    </div>
  );
}
