import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";

const SFN2026 = () => {
  return (
    <div className="min-h-screen bg-background">
      <div className="px-6 py-8 max-w-5xl mx-auto">
        <h1 className="text-4xl font-bold text-foreground mb-4">Join BBQS at SfN 2026!</h1>

        <h3 className="text-xl text-muted-foreground mb-2">Society for Neuroscience Annual Meeting</h3>
        <p className="text-lg font-semibold text-foreground mb-4">Washington, DC</p>

        <p className="text-muted-foreground mb-8">
          An overview of BBQS-related events at this year's Society for Neuroscience Annual Meeting: booths, a session of interest, and the BRAIN Initiative Alliance Toolmakers Showcase.
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
              <TableRow>
                <TableCell className="font-semibold">Sun, Nov 15</TableCell>
                <TableCell>2:00–4:30 PM</TableCell>
                <TableCell>Embodied Cognition: How Does Embodiment Impact Cognitive Processing?</TableCell>
                <TableCell>WCC Rm 151</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-semibold">Sun, Nov 15</TableCell>
                <TableCell>7:00–9:00 PM</TableCell>
                <TableCell>BRAIN Initiative Alliance Toolmakers Showcase (social)</TableCell>
                <TableCell>Marriott Marquis, Independence Ballroom, Salons EFGH</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p className="text-sm text-muted-foreground italic mt-2">
            BBQS poster and presentation times will be added here once the schedule is finalized.
          </p>
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
          <h2 className="text-2xl font-bold text-foreground mb-4">📅 Sunday, November 15</h2>
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Session of Interest: Embodied Cognition</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-muted-foreground">
                <p><strong>How Does Embodiment Impact Cognitive Processing?</strong></p>
                <p>Co-organized by Evan Schaffer and Shreya Saxena.</p>
                <p>🕑 2:00–4:30 PM • 📍 WCC Rm 151</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>BRAIN Initiative Alliance Toolmakers Showcase</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-muted-foreground">
                <p>BRAIN Toolmaker social. Registration is required.</p>
                <p>🕖 7:00–9:00 PM • 📍 Marriott Marquis, Independence Ballroom, Salons EFGH</p>
              </CardContent>
            </Card>
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
