"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { m, AnimatePresence, useReducedMotion } from "@/lib/motion";
import { links } from "@/lib/links";
import {
  DiscordIcon,
  TwitterIcon,
  GitHubIcon,
  MenuIcon,
  CloseIcon,
} from "./icons";
import { Button } from "./ui/Button";

export function HeaderMobileMenu() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  // Focus trap
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const focusable = menuRef.current.querySelectorAll<HTMLElement>(
      'a[href], button, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length > 0) focusable[0].focus();

    function trapFocus(e: KeyboardEvent) {
      if (e.key !== "Tab" || !menuRef.current) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", trapFocus);
    return () => document.removeEventListener("keydown", trapFocus);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        className="md:hidden p-2"
        style={{ color: "var(--text-primary)" }}
        onClick={() => setOpen(!open)}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls="mobile-menu"
        type="button"
      >
        {open ? (
          <CloseIcon className="w-6 h-6" />
        ) : (
          <MenuIcon className="w-6 h-6" />
        )}
      </button>

      <AnimatePresence>
        {open && (
          <m.div
            ref={menuRef}
            id="mobile-menu"
            role="dialog"
            aria-label="Mobile navigation"
            className="absolute top-full left-0 right-0 md:hidden glass overflow-y-auto overscroll-contain"
            style={{ borderTop: "1px solid var(--border-subtle)" }}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.2 }}
          >
            <nav className="px-4 py-4 space-y-4" aria-label="Mobile navigation">
              <a
                href={links.hyperbet}
                target="_blank"
                rel="noopener noreferrer"
                className="block footer-link font-body"
                aria-label="Duel Arena (opens in new tab)"
                onClick={close}
              >
                Duel Arena
              </a>
              <a
                href={links.docs}
                target="_blank"
                rel="noopener noreferrer"
                className="block footer-link font-body"
                aria-label="Docs (opens in new tab)"
              >
                Docs
              </a>
              <div className="flex items-center gap-6">
                <a
                  href={links.discord}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="social-link"
                  aria-label="Discord (opens in new tab)"
                >
                  <DiscordIcon className="w-6 h-6" />
                </a>
                <a
                  href={links.twitter}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="social-link"
                  aria-label="Twitter / X (opens in new tab)"
                >
                  <TwitterIcon className="w-6 h-6" />
                </a>
                <a
                  href={links.github}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="social-link"
                  aria-label="GitHub (opens in new tab)"
                >
                  <GitHubIcon className="w-6 h-6" />
                </a>
              </div>
              <Button
                href={links.game}
                external
                variant="primary"
                className="w-full"
                aria-label="Play Now (opens in new tab)"
              >
                Play Now
              </Button>
            </nav>
          </m.div>
        )}
      </AnimatePresence>
    </>
  );
}
