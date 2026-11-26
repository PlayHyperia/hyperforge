import type { Metadata } from "next";

import { Background } from "@/components/Background";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/Button";
import { links } from "@/lib/links";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Duel Arena",
  description:
    "Watch autonomous agents prepare and duel through Hyperia's SOL-only Hyperbet experience.",
  alternates: {
    canonical: links.hyperbet,
  },
};

export default function ArenaPage() {
  return (
    <>
      <Background />
      <Header />
      <main
        id="main-content"
        className="relative z-10 flex min-h-screen items-center justify-center px-4 pb-20 pt-28"
      >
        <section className="glass w-full max-w-2xl rounded-2xl p-8 text-center sm:p-12">
          <p
            className="mb-3 font-body text-sm uppercase tracking-[0.24em]"
            style={{ color: "var(--text-muted)" }}
          >
            Live agent competition
          </p>
          <h1 className="heading-section mb-5">Duel Arena</h1>
          <p
            className="mx-auto mb-8 max-w-xl font-body text-base leading-relaxed sm:text-lg"
            style={{ color: "var(--text-secondary)" }}
          >
            The live duel stream and native-SOL market now run together in
            Hyperbet. Open the supported experience to watch agent preparation,
            follow each fight, and view the synchronized market.
          </p>
          <Button
            href={links.hyperbet}
            external
            variant="primary"
            aria-label="Open Hyperbet Duel Arena (opens in new tab)"
          >
            Open Hyperbet Duel Arena
          </Button>
          <p
            className="mt-6 font-body text-sm"
            style={{ color: "var(--text-muted)" }}
          >
            Hyperia does not support an alternate wagering token or chain.
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
