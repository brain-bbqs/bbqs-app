import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";

// Shape served by the sfn-2026-presentations edge function (supabase/functions/sfn-2026-presentations).
type Presentation = {
  day: number | null;
  start: number | null;
  end: number | null;
  time: string | null;
  number: string | null;
  title: string;
  presenters: string[];
  link: string | null;
};

const p = (day: number, start: number, end: number | null, time: string, number: string | null, title: string, ...presenters: string[]): Presentation =>
  ({ day, start, end, time, number, title, presenters, link: null });

// Shown until the edge function is deployed, or when it can't reach the sheet: the form answers as
// of 2026-10-21. The live list replaces it as soon as the function answers.
const SNAPSHOT: Presentation[] = [
  p(15, 480, 720, "8:00 AM–12:00 PM", "#3481", "Causal Role of the Right Supramarginal Gyrus in Live Face-to-Face Interaction: Neural and Behavioral Correlates of Eye Movements, Facial Action, and Pupil Dynamics", "Joy Hirsch"),
  p(15, 480, 720, "8:00 AM–12:00 PM", "PSTR060.13", "Context-Aware Multimodal Ecological Research and Assessment Platform Reveals Neural and Physiological Signatures of Anxiety-Memory State During Naturalistic Monitoring", "Hongkun Zhu", "Kun Zhao"),
  p(15, 780, 1020, "1:00–5:00 PM", "#8999", "Comparing fNIRS and fMRI with Surface-Based Registration and Hyper-Resolution Analysis", "Joy Hirsch"),
  p(15, 780, 1020, "1:00–5:00 PM", "PSTR116", "fNIRS-fMRI Reliability for Motor and Social Perception Paradigms: Validation of fNIRS Against fMRI", "Joy Hirsch", "Adam Noah"),
  p(16, 480, 720, "8:00 AM–12:00 PM", "PSTR025.14", "Conspecific vocalizations induce approach behavior in Mongolian gerbils", "Dan Sanes"),
  p(16, 480, 720, "8:00 AM–12:00 PM", "PSTR142.14", "Two-scale temporal organization of vocal communication in Mongolian gerbil families", "Dan Sanes"),
  p(16, 630, 690, "10:30–11:30 AM", null, "Social behaviors: Innate yet flexible", "Dayu Lin"),
  p(17, 480, null, "8:00 AM", "PSTR250.04", "Topological data analysis reveals transient neural states in ferrets during naturalistic social interaction", "Jared Reiling"),
  p(17, 780, 1020, "1:00–5:00 PM", "#5794", "A multimodal approach to identify atypical face processing systems in schizophrenia", "Joy Hirsch"),
  p(17, 780, 1020, "1:00–5:00 PM", "PSTR274.03", "Auditory feature weighting during gerbil vocalization category perception", "Dan Sanes"),
  p(17, 780, 1020, "1:00–5:00 PM", "#3652", "Graph Bispectrum Reveals Increased Nonlinear Cortical Coupling During Live Social Interaction in First-Episode Psychosis", "Joy Hirsch"),
  p(18, 780, 1020, "1:00–5:00 PM", "PSTR383.05", "EMBER: NIH BRAIN's Secure, Collaborative Multi-Modal Data Archive for Human and Animal Behavioral Neuroscience", "Nicole Tregoning"),
  p(18, 780, 1020, "1:00–5:00 PM", "PSTR383.07", "Building Better Data Standards Together: The NWB Enhancement Proposal (NWBEP) Framework and Advances in NWB", "Oliver Ruebel"),
  p(18, 780, 1020, "1:00–5:00 PM", "#8372", "STAMPED principles for reproducible research objects in neuroscience", "Cody Baker"),
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekday = (d: number) => WEEKDAYS[new Date(Date.UTC(2026, 10, d)).getUTCDay()];
const clock = (min: number) => {
  const h = Math.floor(min / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(min % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

const EVENING_EVENTS = [
  {
    day: "Sun, Nov 15",
    time: "7:00–9:00 PM",
    title: "BRAIN Initiative Alliance Toolmakers Showcase",
    location: "Marriott Marquis, Independence Ballroom, Salons EFGH",
    detail: "BRAIN Toolmaker social. Registration is required.",
  },
  {
    day: "Mon, Nov 16",
    time: "7:00–9:00 PM",
    title: "Social Neuroscience Social",
    location: "Hall E – NNE Space #6",
    detail: "A social event for researchers interested in behavioral and neural mechanisms of social behavior. Organized by Steve Chang.",
  },
];

const FIXED_GLANCE = [
  { day: 15, start: 840, time: "2:00–4:30 PM", event: "Embodied Cognition: How Does Embodiment Impact Cognitive Processing?", location: "WCC Rm 151" },
  { day: 15, start: 1140, time: "7:00–9:00 PM", event: "BRAIN Initiative Alliance Toolmakers Showcase (social)", location: "Marriott Marquis, Independence Ballroom, Salons EFGH" },
  { day: 16, start: 1140, time: "7:00–9:00 PM", event: "Social Neuroscience Social", location: "Hall E – NNE Space #6" },
];

const SFN2026 = () => {
  const { data } = useQuery({
    queryKey: ["sfn-2026-presentations"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("sfn-2026-presentations");
      if (error || !data?.ok) throw error ?? new Error(data?.error ?? "unavailable");
      return data.presentations as Presentation[];
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const presentations = data ?? SNAPSHOT;

  const days = [...new Set(presentations.map((x) => x.day).filter((d): d is number => d != null))].sort((a, b) => a - b);
  const undated = presentations.filter((x) => x.day == null);
  const onDay = (d: number) => presentations.filter((x) => x.day === d);

  const glance = [
    ...FIXED_GLANCE,
    ...days.map((d) => {
      const items = onDay(d);
      const starts = items.map((x) => x.start).filter((n): n is number => n != null);
      const ends = items.map((x) => x.end ?? x.start).filter((n): n is number => n != null);
      return {
        day: d,
        start: starts.length ? Math.min(...starts) : 0,
        time: starts.length ? `${clock(Math.min(...starts))}–${clock(Math.max(...ends))}` : "",
        event: `BBQS posters and talks (${items.length})`,
        location: "WCC",
      };
    }),
  ].sort((a, b) => a.day - b.day || a.start - b.start);

  return (
    <div className="min-h-screen bg-background">
      <div className="px-6 py-8 max-w-5xl mx-auto">
        <h1 className="text-4xl font-bold text-foreground mb-4">Join BBQS at SfN 2026!</h1>

        <h3 className="text-xl text-muted-foreground mb-2">Society for Neuroscience Annual Meeting</h3>
        <p className="text-lg font-semibold text-foreground mb-4">Washington, DC</p>

        <p className="text-muted-foreground mb-8">
          An overview of BBQS-related events at this year's Society for Neuroscience Annual Meeting: BBQS posters and talks, booths, a session of interest, and evening socials.
        </p>

        <Separator className="my-8" />

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-foreground mb-4">📊 Schedule at a Glance</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Location</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {glance.map((g) => (
                <TableRow key={`${g.day}-${g.start}-${g.event}`}>
                  <TableCell className="font-semibold whitespace-nowrap">{weekday(g.day).slice(0, 3)}, Nov {g.day}</TableCell>
                  <TableCell className="whitespace-nowrap">{g.time}</TableCell>
                  <TableCell>{g.event}</TableCell>
                  <TableCell>{g.location}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>

        <Separator className="my-8" />

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-foreground mb-4">🌙 Evening Events</h2>
          <div className="grid md:grid-cols-2 gap-4">
            {EVENING_EVENTS.map((e) => (
              <Card key={e.title}>
                <CardHeader>
                  <CardTitle>{e.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-muted-foreground">
                  <p>{e.detail}</p>
                  <p>📅 {e.day} • 🕖 {e.time}</p>
                  <p>📍 {e.location}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <Separator className="my-8" />

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-foreground mb-4">🏢 Visit Our Booths</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Booth #2833: EMBER & BossDB</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground">Learn about the <strong>Ecosystem for Multi-modal Brain-behavior Experimentation and Research</strong> (EMBER) and the <strong>Block Object Storage Service Database</strong> (BossDB).</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Booth #2836: DANDI & NWB</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground">Explore the <strong>Distributed Archives for Neurophysiology Data Integration</strong> (DANDI) and <strong>Neurodata Without Borders</strong> (NWB) standards.</p>
              </CardContent>
            </Card>
          </div>
        </section>

        <Separator className="my-8" />

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-foreground mb-4">🎯 Session of Interest</h2>
          <Card>
            <CardHeader>
              <CardTitle>Embodied Cognition: How Does Embodiment Impact Cognitive Processing?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-muted-foreground">
              <p>Co-organized by Evan Schaffer and Shreya Saxena.</p>
              <p>📅 Sun, Nov 15 • 🕑 2:00–4:30 PM • 📍 WCC Rm 151</p>
            </CardContent>
          </Card>
        </section>

        <Separator className="my-8" />

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-foreground mb-2">🔬 BBQS Posters & Talks</h2>
          <p className="text-sm text-muted-foreground mb-6">
            Updated automatically from the BBQS SfN form, for presenters who agreed to be listed here.
          </p>
          <div className="space-y-8">
            {[...days.map((d) => ({ heading: `${weekday(d)}, November ${d}`, items: onDay(d) })),
              ...(undated.length ? [{ heading: "Date to be confirmed", items: undated }] : [])].map((group) => (
              <div key={group.heading}>
                <h3 className="text-xl font-semibold text-foreground mb-3">📅 {group.heading}</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Number</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Presenter(s)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.items.map((x) => (
                      <TableRow key={`${x.number ?? x.link ?? x.time}-${x.title}`}>
                        <TableCell className="whitespace-nowrap">{x.time ?? "—"}</TableCell>
                        <TableCell className="whitespace-nowrap">{x.number ?? "—"}</TableCell>
                        <TableCell className="font-medium">
                          {x.title || null}
                          {x.link && (
                            <a href={x.link} className="text-primary hover:underline ml-1" target="_blank" rel="noopener noreferrer">
                              {x.title ? "(abstract)" : "View abstract"}
                            </a>
                          )}
                        </TableCell>
                        <TableCell>{x.presenters.join(", ")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))}
          </div>
        </section>

        <Separator className="my-8" />

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-foreground mb-4">🔗 Learn More</h2>
          <ul className="list-disc pl-6 text-muted-foreground space-y-1">
            <li><a href="https://www.sfn.org/meetings/neuroscience-2026" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">SfN Meeting Website</a></li>
            <li><a href="/sfn-2025" className="text-primary hover:underline">BBQS at SfN 2025</a></li>
            <li>Questions? <a href="mailto:admin@brain-bbqs.org" className="text-primary hover:underline">admin@brain-bbqs.org</a></li>
          </ul>
        </section>
      </div>
    </div>
  );
};

export default SFN2026;
