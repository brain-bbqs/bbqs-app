import { PageMeta } from "@/components/PageMeta";
import { Link } from "react-router-dom";
import { CalendarDays } from "lucide-react";
import { SFN_2026_FIXED_EVENTS } from "@/data/sfn2026-events";

const CALENDAR_EMBED_URL =
  "https://calendar.google.com/calendar/embed?height=600&wkst=1&ctz=America/New_York&showPrint=0&mode=AGENDA&title=BBQS+Events+Calendar&src=YWRtaW5AYnJhaW4tYmJxcy5vcmc&color=%23039BE5";

export default function Calendar() {
  return (
    <div className="min-h-screen bg-background">
      <PageMeta title="Calendar | BBQS" description="BBQS consortium events calendar" />

      <div className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/8 via-transparent to-accent/5" />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 py-10">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shadow-lg shadow-primary/10 border border-primary/10">
              <CalendarDays className="h-7 w-7 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-foreground tracking-tight">Events Calendar</h1>
              <p className="text-muted-foreground mt-1">Upcoming meetings, workshops, and conferences</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <div className="rounded-xl border border-border overflow-hidden bg-card shadow-sm">
          <iframe
            src={CALENDAR_EMBED_URL}
            className="w-full border-0"
            style={{ minHeight: "700px" }}
            title="BBQS Events Calendar"
            loading="lazy"
          />
        </div>

        <section className="mt-8">
          <h2 className="text-xl font-bold text-foreground mb-3">SfN 2026 · Washington, DC</h2>
          <ul className="rounded-xl border border-border bg-card divide-y divide-border">
            {SFN_2026_FIXED_EVENTS.map((e) => (
              <li key={`${e.day}-${e.start}`} className="px-4 py-3 text-sm">
                <span className="font-semibold">Nov {e.day}, {e.time}</span> — {e.event}
                <span className="text-muted-foreground"> · {e.location}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground mt-2">
            BBQS posters and talks are listed on the <Link to="/sfn-2026" className="underline">SfN 2026 page</Link>.
          </p>
        </section>
      </div>
    </div>
  );
}
