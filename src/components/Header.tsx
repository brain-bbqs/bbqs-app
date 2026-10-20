import { Link } from "react-router-dom";

const Header = () => {
  const navLinks = [
    { label: "About", href: "#" },
    { label: "Projects", href: "/projects" },
    { label: "SFN 2026", href: "/sfn-2026" },
    { label: "SFN 2025", href: "/sfn-2025" },
    { label: "Working Groups", href: "/working-groups" },
    { label: "Resources", href: "/resources" },
    { label: "Announcements", href: "/announcements" },
    { label: "Progress", href: "/progress" },
    { label: "Job Board", href: "#" },
    { label: "Calendar", href: "#" },
  ];

  return (
    <header className="bg-card border-b border-border px-6 py-3">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <Link to="/" className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary to-accent" />
          <span className="font-semibold text-foreground">
            Brain Behavior Quantification and Synchronization
          </span>
        </Link>
        
        <nav className="hidden md:flex items-center gap-6">
          {navLinks.map((link) => (
            link.href.startsWith("/") ? (
              <Link
                key={link.label}
                to={link.href}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {link.label}
              </Link>
            ) : (
              <a
                key={link.label}
                href={link.href}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {link.label}
              </a>
            )
          ))}
        </nav>
      </div>
    </header>
  );
};

export default Header;
