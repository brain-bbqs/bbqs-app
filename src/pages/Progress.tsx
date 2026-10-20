import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress as Bar } from "@/components/ui/progress";
import { CheckCircle2, Circle, CircleDot, ExternalLink, Gauge, Rocket, Sparkles } from "lucide-react";

// Everything on this page comes from data/progress.json, which scripts/progress/build-progress.mjs
// writes from the BBQS project board at each site build (docs/roadmap-and-progress.md). Nothing here
// is kept by hand: change the board, and the page follows on the next build.

type Measure = { label: string; value: string; goal: string };
type Milestone = {
  number: number; url: string; title: string; status: string; start?: string; target?: string;
  done_when: string | null; now: string | null; measures?: Measure[];
  progress: { completed: number; total: number; percent: number };
};
type Phase = Omit<Milestone, "measures"> & { what: string | null; milestones: Milestone[]; measures?: Measure[] };
type Report = {
  generated_at: string; project: { title: string; url: string; public: boolean };
  phases: Phase[]; not_on_roadmap: { number: number }[]; milestones: { total: number; done: number };
};

type Stage = "now" | "next" | "later" | "done";
const stageOf = (p: Phase): Stage =>
  p.status === "Done" ? "done" : /\(later\)/i.test(p.title) ? "later" : p.status === "In progress" ? "now" : "next";

const STAGE: Record<Stage, { label: string; hint: string; dot: string; text: string; bar: string; glow: string }> = {
  now: { label: "Now", hint: "In progress", dot: "bg-primary", text: "text-primary",
    bar: "bg-gradient-to-r from-primary to-primary/70", glow: "shadow-[0_0_40px_-8px_hsl(var(--primary)/0.55)]" },
  next: { label: "Next", hint: "Up next", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400",
    bar: "bg-gradient-to-r from-amber-500 to-amber-400", glow: "shadow-[0_0_40px_-10px_hsl(38_90%_50%/0.55)]" },
  later: { label: "Later", hint: "On the horizon", dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400",
    bar: "bg-gradient-to-r from-sky-500 to-sky-400", glow: "shadow-[0_0_40px_-10px_hsl(200_90%_50%/0.45)]" },
  done: { label: "Done", hint: "Finished", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400",
    bar: "bg-gradient-to-r from-emerald-500 to-emerald-400", glow: "" },
};

const day = (s?: string | null) => s
  ? new Date(s.length === 10 ? s + "T00:00:00Z" : s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
  : null;
const milestonePct = (p: Phase) => p.milestones.length
  ? Math.round(100 * p.milestones.filter(m => m.status === "Done").length / p.milestones.length) : 0;

async function fetchReport(): Promise<Report> {
  const r = await fetch(`${import.meta.env.BASE_URL}data/progress.json`, { cache: "no-cache" });
  if (!r.ok) throw new Error(`progress.json: ${r.status}`);
  return r.json();
}

function StatusIcon({ status, className }: { status: string; className?: string }) {
  if (status === "Done") return <CheckCircle2 className={cn("w-4 h-4 text-emerald-600 dark:text-emerald-400", className)} />;
  if (status === "In progress") return <CircleDot className={cn("w-4 h-4 text-primary", className)} />;
  return <Circle className={cn("w-4 h-4 text-muted-foreground", className)} />;
}

function MeasureTiles({ measures }: { measures: Measure[] }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {measures.map(m => (
        <div key={m.label} className="rounded-lg border bg-background/60 p-3">
          <div className="text-2xl font-bold tabular-nums">{m.value}</div>
          <div className="text-xs text-muted-foreground leading-snug">{m.label}</div>
          <div className="text-xs text-muted-foreground mt-1">Goal: {m.goal}</div>
        </div>
      ))}
    </div>
  );
}

// The Now -> Next -> Later rail: every phase, placed by where it stands.
function Journey({ phases }: { phases: Phase[] }) {
  const stages = (["done", "now", "next", "later"] as Stage[]).filter(s => phases.some(p => stageOf(p) === s));
  const go = (n: number) => document.getElementById(`phase-${n}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <div className="relative rounded-2xl border bg-gradient-to-br from-card via-card to-muted/20 p-6 sm:p-8 overflow-hidden">
      <div className="pointer-events-none absolute -top-24 -left-24 w-96 h-96 rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-24 w-[28rem] h-[28rem] rounded-full bg-sky-500/10 blur-3xl" />
      <div className="relative flex items-end justify-between gap-3 flex-wrap mb-8">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">The roadmap</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-bold">{stages.map(s => STAGE[s].label).join(" → ")}</h2>
        </div>
        <div className="flex items-center gap-4 text-xs flex-wrap">
          {stages.map(s => (
            <span key={s} className="flex items-center gap-1.5 text-muted-foreground">
              <span className={cn("w-2 h-2 rounded-full", STAGE[s].dot)} />{STAGE[s].hint}
            </span>
          ))}
        </div>
      </div>

      <div className="relative">
        <div className="hidden md:block absolute left-0 right-0 top-[44px] h-[3px] rounded-full bg-gradient-to-r from-primary/60 via-amber-500/60 to-sky-500/60" />
        <div className="md:hidden absolute left-[11px] top-2 bottom-2 w-[3px] rounded-full bg-gradient-to-b from-primary/60 via-amber-500/60 to-sky-500/60" />
        <div className={cn("relative grid gap-6", stages.length > 3 ? "md:grid-cols-4" : stages.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2")}>
          {stages.map(s => (
            <div key={s} className="relative pl-8 md:pl-0 md:flex md:flex-col md:items-center">
              <span className={cn("md:hidden absolute left-0 top-0.5 w-6 h-6 rounded-full ring-4 ring-background", STAGE[s].dot)} />
              <span className={cn("block mb-3 text-[11px] font-bold uppercase tracking-widest", STAGE[s].text)}>{STAGE[s].label}</span>
              <div className="hidden md:flex relative items-center justify-center h-8 mb-6">
                {s === "now" && <span className={cn("absolute w-6 h-6 rounded-full opacity-30 motion-safe:animate-ping", STAGE[s].dot)} />}
                <span className={cn("relative w-5 h-5 rounded-full ring-4 ring-background", STAGE[s].dot, STAGE[s].glow)} />
              </div>
              <div className="w-full space-y-3">
                {phases.filter(p => stageOf(p) === s).map(p => {
                  const pct = milestonePct(p);
                  return (
                    <button key={p.number} onClick={() => go(p.number)}
                      className={cn("group relative w-full text-left rounded-xl border bg-card/80 backdrop-blur-sm p-4 transition-all duration-300",
                        "hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg shadow-sm")}>
                      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
                      <h3 className="font-semibold text-sm leading-tight mb-1 group-hover:text-primary transition-colors">{p.title}</h3>
                      {p.what && <p className="text-xs text-muted-foreground leading-snug line-clamp-3 mb-3">{p.what}</p>}
                      {p.milestones.length > 0 ? (
                        <div className="space-y-1.5">
                          <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
                            <span>{p.milestones.filter(m => m.status === "Done").length} of {p.milestones.length} milestones</span>
                            {p.target && <span>target {day(p.target)}</span>}
                          </div>
                          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                            <div className={cn("h-full rounded-full", STAGE[s].bar)} style={{ width: `${Math.max(pct, 4)}%` }} />
                          </div>
                        </div>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">Milestones to be defined</p>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// The phase in progress, as a line of milestones from the first to the finish.
function CurrentFocus({ phase }: { phase: Phase }) {
  const ms = phase.milestones;
  const done = ms.filter(m => m.status === "Done").length;
  const current = ms.findIndex(m => m.status !== "Done");
  return (
    <div className="rounded-xl border bg-card p-6 space-y-6">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-primary/10"><Rocket className="w-5 h-5 text-primary" /></div>
        <div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">Current focus</div>
          <h2 className="font-semibold text-lg">{phase.title}</h2>
          <p className="text-sm text-muted-foreground">
            {done} of {ms.length} milestones done{phase.target ? ` · target ${day(phase.target)}` : ""}
          </p>
        </div>
      </div>
      <Bar value={ms.length ? (100 * done) / ms.length : 0} className="h-2" />

      <ol className="relative grid gap-4 md:gap-2" style={{ gridTemplateColumns: `repeat(${ms.length}, minmax(0, 1fr))` }}>
        <span className="hidden md:block absolute top-4 left-[12%] right-[12%] h-0.5 bg-border" aria-hidden />
        {ms.map((m, i) => {
          const isDone = m.status === "Done", isCurrent = i === current;
          return (
            <li key={m.number} className="relative flex flex-col items-center text-center">
              <a href={m.url} target="_blank" rel="noopener noreferrer"
                className={cn("relative z-10 w-8 h-8 rounded-full border-2 flex items-center justify-center bg-background transition-colors",
                  isDone ? "bg-primary border-primary text-primary-foreground"
                    : isCurrent ? "border-primary text-primary ring-4 ring-primary/15" : "border-muted-foreground/30 text-muted-foreground")}
                title={`${m.title} (opens the issue)`}>
                {isDone ? <CheckCircle2 className="w-4 h-4" /> : <span className="text-xs font-semibold">{i + 1}</span>}
              </a>
              <p className={cn("mt-2 text-xs sm:text-sm font-medium leading-snug", isDone && "text-muted-foreground", isCurrent && "text-primary")}>{m.title}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{isDone ? "done" : m.target ? day(m.target) : ""}</p>
              {m.progress.total > 0 && (
                <Badge variant="secondary" className={cn("mt-1 text-[10px] tabular-nums", isCurrent && "bg-primary/10 text-primary")}>
                  {m.progress.percent}% of work
                </Badge>
              )}
            </li>
          );
        })}
      </ol>
      {phase.measures && phase.measures.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground font-semibold">
            <Gauge className="w-3.5 h-3.5" /> Measured every day
          </div>
          <MeasureTiles measures={phase.measures} />
        </div>
      )}
    </div>
  );
}

function PhaseDetail({ phase }: { phase: Phase }) {
  const s = stageOf(phase);
  return (
    <section id={`phase-${phase.number}`} className="scroll-mt-24 rounded-xl border bg-card p-6 space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold">{phase.title}</h2>
        <Badge variant="outline" className={cn("text-[11px]", STAGE[s].text)}>{phase.status}</Badge>
        {phase.target && <span className="text-xs text-muted-foreground">target {day(phase.target)}</span>}
        <a href={phase.url} target="_blank" rel="noopener noreferrer"
          className="ml-auto text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1">
          On GitHub <ExternalLink className="w-3 h-3" />
        </a>
      </div>
      {phase.what && <p className="text-sm text-muted-foreground max-w-3xl">{phase.what}</p>}
      {phase.milestones.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">{phase.done_when || "Milestones to be defined."}</p>
      ) : (
        <ol className="divide-y">
          {phase.milestones.map(m => (
            <li key={m.number} className="py-4 grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              <StatusIcon status={m.status} className="mt-0.5" />
              <div className="flex flex-wrap items-baseline gap-x-3">
                <a href={m.url} target="_blank" rel="noopener noreferrer" className="font-medium hover:text-primary">{m.title}</a>
                <span className="text-xs text-muted-foreground">{m.status === "Done" ? "done" : m.target ? `target ${day(m.target)}` : ""}</span>
              </div>
              <div className="col-start-2 space-y-1.5 text-sm">
                {m.done_when && <p><span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mr-1.5">Done when</span>{m.done_when}</p>}
                {m.status !== "Done" && (m.measures?.length ? (
                  <p><span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mr-1.5">Now</span>
                    {m.measures.map((x, i) => (
                      <span key={x.label}>{i > 0 && "; "}{x.label.toLowerCase()} <b className="tabular-nums">{x.value}</b> <span className="text-muted-foreground">(goal {x.goal})</span></span>
                    ))}</p>
                ) : m.now ? (
                  <p><span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mr-1.5">Now</span>{m.now}</p>
                ) : null)}
                {m.progress.total > 0 && (
                  <div className="flex items-center gap-3 max-w-md">
                    <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                      <div className={cn("h-full rounded-full", STAGE[s].bar)} style={{ width: `${Math.max(m.progress.percent, 3)}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">{m.progress.completed} of {m.progress.total} work items</span>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function ProgressPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["progress-report"], queryFn: fetchReport, staleTime: 10 * 60 * 1000 });
  const built = data ? new Date(data.generated_at) : null;
  const stale = built ? Date.now() - built.getTime() > 48 * 3600 * 1000 : false;
  const focus = data?.phases.filter(p => stageOf(p) === "now" && p.milestones.length > 0) ?? [];

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8 max-w-6xl space-y-8">
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold">Progress</h1>
              {built && <Badge variant="outline" className="text-[10px] uppercase tracking-wide">Updated {day(data!.generated_at)}</Badge>}
              {stale && <Badge variant="outline" className="text-[10px] uppercase tracking-wide border-amber-500/50 text-amber-600 dark:text-amber-400">Not refreshed in 2+ days</Badge>}
            </div>
            <p className="text-sm text-muted-foreground max-w-2xl">
              Where BBQS is going, phase by phase, and how far each part has come. Each milestone has a clear
              finish line. This page is rebuilt every day from the BBQS project board.
            </p>
          </div>
          {data?.project.public && (
            <Button variant="outline" size="sm" asChild>
              <a href={data.project.url} target="_blank" rel="noopener noreferrer">
                Project board <ExternalLink className="w-3.5 h-3.5 ml-2" />
              </a>
            </Button>
          )}
        </header>

        {isLoading && <p className="text-sm text-muted-foreground">Loading progress…</p>}
        {error && (
          <div className="rounded-xl border p-6 text-sm text-muted-foreground">
            The progress report isn't available on this copy of the site yet. It's built from the project board
            when the site is deployed.
          </div>
        )}

        {data && (
          <>
            <Journey phases={data.phases} />
            {focus.map(p => <CurrentFocus key={p.number} phase={p} />)}
            <div className="space-y-4">
              {data.phases.map(p => <PhaseDetail key={p.number} phase={p} />)}
            </div>
            <p className="text-xs text-muted-foreground">
              {data.milestones.done} of {data.milestones.total} milestones done across {data.phases.length} phases.
              {data.not_on_roadmap.length > 0 && ` ${data.not_on_roadmap.length} open issue${data.not_on_roadmap.length === 1 ? " is" : "s are"} not yet placed on the roadmap.`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
