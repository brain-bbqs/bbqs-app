import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";

type Presentation = { time: string; number?: string; title: string; presenters: string; kind?: "Talk" };

// From the "SFN2026 - Talks and Posters" form responses, limited to presenters who agreed to share
// their poster or talk on the website. Duplicate submissions of one poster are merged.
const PRESENTATIONS: { day: string; items: Presentation[] }[] = [
  {
    day: "Sunday, November 15",
    items: [
      { time: "8:00 AM–12:00 PM", number: "PSTR060.13", title: "Context-Aware Multimodal Ecological Research and Assessment Platform Reveals Neural and Physiological Signatures of Anxiety-Memory State During Naturalistic Monitoring", presenters: "Hongkun Zhu, Kun Zhao" },
      { time: "8:00 AM–12:00 PM", number: "#3481", title: "Causal Role of the Right Supramarginal Gyrus in Live Face-to-Face Interaction: Neural and Behavioral Correlates of Eye Movements, Facial Action, and Pupil Dynamics", presenters: "Joy Hirsch" },
      { time: "1:00–5:00 PM", number: "PSTR116 (Optical Methods II)", title: "fNIRS-fMRI Reliability for Motor and Social Perception Paradigms: Validation of fNIRS Against fMRI", presenters: "Adam Noah, Joy Hirsch" },
      { time: "1:00–5:00 PM", number: "#8999", title: "Comparing fNIRS and fMRI with Surface-Based Registration and Hyper-Resolution Analysis", presenters: "Joy Hirsch" },
    ],
  },
  {
    day: "Monday, November 16",
    items: [
      { time: "8:00 AM–12:00 PM", number: "PSTR142.14", title: "Two-scale temporal organization of vocal communication in Mongolian gerbil families", presenters: "Dan Sanes" },
      { time: "8:00 AM–12:00 PM", number: "PSTR025.14", title: "Conspecific vocalizations induce approach behavior in Mongolian gerbils", presenters: "Dan Sanes" },
      { time: "10:30–11:30 AM", title: "Social behaviors: Innate yet flexible", presenters: "Dayu Lin", kind: "Talk" },
    ],
  },
  {
    day: "Tuesday, November 17",
    items: [
      { time: "8:00 AM", number: "PSTR250.04", title: "Topological data analysis reveals transient neural states in ferrets during naturalistic social interaction", presenters: "Jared Reiling" },
      { time: "1:00–5:00 PM", number: "#5794", title: "A multimodal approach to identify atypical face processing systems in schizophrenia", presenters: "Joy Hirsch" },
      { time: "1:00–5:00 PM", number: "#3652", title: "Graph Bispectrum Reveals Increased Nonlinear Cortical Coupling During Live Social Interaction in First-Episode Psychosis", presenters: "Joy Hirsch" },
      { time: "1:00–5:00 PM", number: "PSTR274.03", title: "Auditory feature weighting during gerbil vocalization category perception", presenters: "Dan Sanes" },
    ],
  },
  {
    day: "Wednesday, November 18",
    items: [
      { time: "1:00–5:00 PM", number: "PSTR383.05", title: "EMBER: NIH BRAIN's Secure, Collaborative Multi-Modal Data Archive for Human and Animal Behavioral Neuroscience", presenters: "Nicole Tregoning" },
      { time: "1:00–5:00 PM", number: "PSTR383.07", title: "Building Better Data Standards Together: The NWB Enhancement Proposal (NWBEP) Framework and Advances in NWB", presenters: "Ryan Ly, Oliver Ruebel et al." },
      { time: "1:00–5:00 PM", number: "#8372", title: "STAMPED principles for reproducible research objects in neuroscience", presenters: "Cody Baker" },
    ],
  },
];

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

const count = (day: string) => PRESENTATIONS.find((d) => d.day.startsWith(day))?.items.length ?? 0;

const GLANCE = [
  { day: "Sun, Nov 15", time: "8:00 AM–5:00 PM", event: `BBQS posters (${count("Sunday")})`, location: "WCC poster halls" },
  { day: "Sun, Nov 15", time: "2:00–4:30 PM", event: "Embodied Cognition: How Does Embodiment Impact Cognitive Processing?", location: "WCC Rm 151" },
  { day: "Sun, Nov 15", time: "7:00–9:00 PM", event: "BRAIN Initiative Alliance Toolmakers Showcase (social)", location: "Marriott Marquis, Independence Ballroom, Salons EFGH" },
  { day: "Mon, Nov 16", time: "8:00 AM–12:00 PM", event: `BBQS posters and talk (${count("Monday")})`, location: "WCC" },
  { day: "Mon, Nov 16", time: "7:00–9:00 PM", event: "Social Neuroscience Social", location: "Hall E – NNE Space #6" },
  { day: "Tue, Nov 17", time: "8:00 AM–5:00 PM", event: `BBQS posters (${count("Tuesday")})`, location: "WCC poster halls" },
  { day: "Wed, Nov 18", time: "1:00–5:00 PM", event: `BBQS posters (${count("Wednesday")})`, location: "WCC poster halls" },
];

const SFN2026 = () => {
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
              {GLANCE.map((g) => (
                <TableRow key={`${g.day}-${g.time}-${g.event}`}>
                  <TableCell className="font-semibold whitespace-nowrap">{g.day}</TableCell>
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
          <h2 className="text-2xl font-bold text-foreground mb-6">🔬 BBQS Posters & Talks</h2>
          <div className="space-y-8">
            {PRESENTATIONS.map((d) => (
              <div key={d.day}>
                <h3 className="text-xl font-semibold text-foreground mb-3">📅 {d.day}</h3>
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
                    {d.items.map((p) => (
                      <TableRow key={`${p.number ?? p.time}-${p.title}`}>
                        <TableCell className="whitespace-nowrap">{p.time}</TableCell>
                        <TableCell className="whitespace-nowrap">{p.kind ?? p.number}</TableCell>
                        <TableCell className="font-medium">{p.title}</TableCell>
                        <TableCell>{p.presenters}</TableCell>
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
