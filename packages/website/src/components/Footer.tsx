import Image from "next/image";
import { links, navigation } from "@/lib/links";
import { DiscordIcon, TwitterIcon, GitHubIcon } from "./icons";

type FooterLinkProps = {
  href: string;
  children: React.ReactNode;
  external?: boolean;
  "aria-label"?: string;
};

function FooterLink({
  href,
  children,
  external = false,
  "aria-label": ariaLabel,
}: FooterLinkProps) {
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className="block font-body text-sm relative group footer-link"
      aria-label={ariaLabel}
    >
      {children}
      <span
        className="absolute bottom-0 left-0 w-0 h-px transition-[width] duration-300 group-hover:w-full"
        style={{ background: "var(--gold-essence)" }}
      />
    </a>
  );
}

export function Footer() {
  return (
    <footer
      className="relative z-[3] footer-game"
      style={{ background: "var(--bg-depth)" }}
    >
      {/* Top gradient line */}
      <div
        className="divider-gold divider-gold-wide max-w-md mx-auto"
        aria-hidden="true"
      >
        <span className="w-1 h-1 rotate-45 bg-[var(--gold-dim)] shrink-0" />
      </div>

      <div
        className="max-w-6xl mx-auto container-padding p-8 sm:p-10 md:p-12 mb-8"
        style={{
          borderTop: "1px solid var(--gold-border-subtle)",
        }}
      >
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 md:gap-12 mb-8">
          {/* Brand */}
          <div className="md:col-span-1">
            <Image
              src="/images/hyperia-wordmark.svg"
              alt="Hyperia"
              width={160}
              height={30}
              className="h-6 w-auto mb-4"
            />
            <p
              className="text-sm font-body leading-relaxed"
              style={{ color: "var(--text-muted)" }}
            >
              The first AI-native MMORPG where autonomous agents play alongside
              humans.
            </p>
          </div>

          {/* Game Links */}
          <nav aria-label="Game links">
            <h3
              className="font-display text-sm uppercase tracking-wider mb-4"
              style={{ color: "var(--text-primary)" }}
            >
              Game
            </h3>
            <ul className="space-y-3">
              {navigation.footer.game.map((link) => (
                <li key={link.label}>
                  <FooterLink
                    href={link.href}
                    external={link.external}
                    aria-label={
                      link.external
                        ? `${link.label} (opens in new tab)`
                        : undefined
                    }
                  >
                    {link.label}
                  </FooterLink>
                </li>
              ))}
            </ul>
          </nav>

          {/* Community Links */}
          <nav aria-label="Community links">
            <h3
              className="font-display text-sm uppercase tracking-wider mb-4"
              style={{ color: "var(--text-primary)" }}
            >
              Community
            </h3>
            <ul className="space-y-3">
              {navigation.footer.community.map((link) => (
                <li key={link.label}>
                  <FooterLink
                    href={link.href}
                    external={link.external}
                    aria-label={
                      link.external
                        ? `${link.label} (opens in new tab)`
                        : undefined
                    }
                  >
                    {link.label}
                  </FooterLink>
                </li>
              ))}
            </ul>
          </nav>

          {/* Resources Links */}
          <nav aria-label="Resources">
            <h3
              className="font-display text-sm uppercase tracking-wider mb-4"
              style={{ color: "var(--text-primary)" }}
            >
              Resources
            </h3>
            <ul className="space-y-3">
              {navigation.footer.resources.map((link) => (
                <li key={link.label}>
                  <FooterLink
                    href={link.href}
                    external={link.external}
                    aria-label={
                      link.external
                        ? `${link.label} (opens in new tab)`
                        : undefined
                    }
                  >
                    {link.label}
                  </FooterLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        {/* Social links */}
        <div
          className="pt-6 flex items-center justify-center gap-6"
          style={{ borderTop: "1px solid rgba(90, 95, 105, 0.25)" }}
        >
          <a
            href={links.discord}
            target="_blank"
            rel="noopener noreferrer"
            className="social-link"
            aria-label="Discord (opens in new tab)"
          >
            <DiscordIcon className="w-5 h-5" />
          </a>
          <a
            href={links.twitter}
            target="_blank"
            rel="noopener noreferrer"
            className="social-link"
            aria-label="Twitter / X (opens in new tab)"
          >
            <TwitterIcon className="w-5 h-5" />
          </a>
          <a
            href={links.github}
            target="_blank"
            rel="noopener noreferrer"
            className="social-link"
            aria-label="GitHub (opens in new tab)"
          >
            <GitHubIcon className="w-5 h-5" />
          </a>
        </div>
      </div>

      {/* Bottom copyright bar */}
      <div className="max-w-6xl mx-auto container-padding pb-8">
        <p
          className="text-sm font-body text-center"
          style={{ color: "var(--text-muted)" }}
        >
          &copy; {new Date().getFullYear()} Hyperia. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
