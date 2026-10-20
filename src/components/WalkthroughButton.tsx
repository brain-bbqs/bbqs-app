import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { HelpCircle, X, ChevronRight, ChevronLeft, Compass, BookOpen, FlaskConical, Map, Brain, FolderOpen, Users } from "lucide-react";

interface Step {
  icon: typeof Compass;
  title: string;
  description: string;
  route: string;
  cta?: string;
  color: string;
}

const steps: Step[] = [
  {
    icon: Compass,
    title: "Welcome to BBQS!",
    description: "The Brain Behavior Quantification and Synchronization consortium hub. Let's take a quick tour of the key features — click \"Next\" to begin!",
    route: "/",
    color: "bg-[hsl(222_47%_20%)]",
  },
  {
    icon: FolderOpen,
    title: "Browse Projects",
    description: "All BBQS-funded projects are listed here with their species, PIs, and Marr-level annotations. Click any project card to see its full details.",
    route: "/projects",
    cta: "Try clicking a project to explore its details.",
    color: "bg-[hsl(38_90%_50%)]",
  },


  {
    icon: BookOpen,
    title: "Publications",
    description: "Browse publications from BBQS investigators organized by project and grant.",
    route: "/publications",
    cta: "Click a publication to explore details.",
    color: "bg-[hsl(220_80%_55%)]",
  },
  {
    icon: Users,
    title: "People & Working Groups",
    description: "Meet the investigators behind BBQS projects and explore the consortium's working groups and community.",
    route: "/investigators",
    cta: "Click a PI to see their grants and publications.",
    color: "bg-[hsl(280_60%_50%)]",
  },
  {
    icon: Map,
    title: "You're all set!",
    description: "That's the tour! Use the sidebar to navigate anytime. See Progress for where BBQS is heading, or click the ? button again to replay this walkthrough.",
    route: "/progress",
    color: "bg-[hsl(222_47%_20%)]",
  },
];

export function WalkthroughButton() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();

  const current = steps[step];
  const Icon = current.icon;

  const goToStep = (index: number) => {
    setStep(index);
    const target = steps[index];
    if (target.route !== location.pathname) {
      navigate(target.route);
    }
  };

  const handleOpen = () => {
    setOpen(true);
    setStep(0);
    if (location.pathname !== "/") {
      navigate("/");
    }
  };

  const handleClose = () => setOpen(false);

  // Navigate when step changes
  useEffect(() => {
    if (open && current.route !== location.pathname) {
      navigate(current.route);
    }
  }, [step, open]);

  return (
    <>
      {/* Floating button */}
      {!open && (
        <button
          onClick={handleOpen}
          className="fixed top-4 right-4 z-50 w-10 h-10 rounded-full bg-gradient-to-br from-[hsl(222_47%_20%)] to-[hsl(229_50%_15%)] text-[hsl(0_0%_100%)] shadow-md hover:shadow-lg hover:scale-110 transition-all flex items-center justify-center"
          title="Take a guided tour"
        >
          <HelpCircle className="h-5 w-5" />
        </button>
      )}

      {/* Tour card — bottom-right, no overlay so user can see the page */}
      {open && (
        <div className="fixed top-14 right-4 z-50 w-[380px] max-w-[calc(100vw-2rem)] animate-in slide-in-from-top-4 fade-in duration-300">
          {/* Card */}
          <div className="bg-card border border-border rounded-2xl shadow-2xl overflow-hidden">
            {/* Gradient bar */}
            <div className={`h-1.5 bg-gradient-to-r ${
              step % 2 === 0
                ? "from-[hsl(222_47%_20%)] via-[hsl(38_90%_50%)] to-[hsl(150_60%_40%)]"
                : "from-[hsl(38_90%_50%)] via-[hsl(280_60%_50%)] to-[hsl(222_47%_20%)]"
            }`} />

            {/* Close */}
            <button
              onClick={handleClose}
              className="absolute top-3.5 right-3.5 w-6 h-6 rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>

            {/* Content */}
            <div className="p-5 pb-3">
              <div className="flex items-center gap-3 mb-3">
                <div className={`w-11 h-11 rounded-xl ${current.color} flex items-center justify-center shrink-0`}>
                  <Icon className="h-5 w-5 text-[hsl(0_0%_100%)]" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
                    Step {step + 1} of {steps.length}
                  </p>
                  <h3 className="text-[15px] font-bold text-foreground leading-snug">{current.title}</h3>
                </div>
              </div>
              <p className="text-[13px] text-muted-foreground leading-relaxed mb-1">{current.description}</p>
              {current.cta && (
                <p className="text-[12px] text-[hsl(38_90%_50%)] font-semibold flex items-center gap-1 mt-2">
                  <ChevronRight className="h-3 w-3" />
                  {current.cta}
                </p>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 pb-4 pt-1 flex items-center justify-between">
              {/* Progress bar */}
              <div className="flex gap-1">
                {steps.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => goToStep(i)}
                    className={`h-1.5 rounded-full transition-all duration-300 ${
                      i === step ? "w-7 bg-[hsl(38_90%_50%)]" :
                      i < step ? "w-3 bg-[hsl(222_47%_20%/0.4)]" :
                      "w-1.5 bg-border"
                    }`}
                  />
                ))}
              </div>

              {/* Nav */}
              <div className="flex gap-2">
                {step > 0 && (
                  <button
                    onClick={() => goToStep(step - 1)}
                    className="h-8 w-8 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                )}
                {step < steps.length - 1 ? (
                  <button
                    onClick={() => goToStep(step + 1)}
                    className="h-8 px-4 rounded-lg bg-[hsl(222_47%_20%)] text-[hsl(0_0%_100%)] text-xs font-semibold hover:bg-[hsl(222_47%_25%)] transition-colors flex items-center gap-1.5"
                  >
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button
                    onClick={handleClose}
                    className="h-8 px-4 rounded-lg bg-[hsl(38_90%_50%)] text-[hsl(222_47%_15%)] text-xs font-bold hover:bg-[hsl(38_90%_55%)] transition-colors"
                  >
                    Start Exploring!
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Skip link */}
          <button
            onClick={handleClose}
            className="w-full text-center text-[11px] text-muted-foreground/60 hover:text-muted-foreground mt-2 transition-colors"
          >
            Skip tour
          </button>
        </div>
      )}
    </>
  );
}
