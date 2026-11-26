import Image from "next/image";
import { Button } from "../ui/Button";
import { links } from "@/lib/links";
import { FadeIn } from "@/lib/motion";

export function Hero() {
  return (
    <section className="relative -mt-16 md:-mt-20">
      {/* Background image — absolute, fills entire section including behind header */}
      <div className="absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
        <Image
          src="/images/hero-image.png"
          alt=""
          fill
          className="object-cover object-[80%_25%] scale-[1.00]"
          priority
          quality={90}
          sizes="100vw"
        />
        {/* Left darken for text readability */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(to right, rgba(11,12,14,0.85) 0%, rgba(11,12,14,0.5) 35%, rgba(11,12,14,0.2) 60%, transparent 100%)",
          }}
        />
      </div>

      {/* Bottom vignette — very thin fade, image visible right up to gold line */}
      <div
        aria-hidden="true"
        className="absolute bottom-0 left-0 right-0 z-[1] h-16 pointer-events-none"
        style={{
          background:
            "linear-gradient(to bottom, transparent 0%, rgba(11,12,14,0.85) 60%, var(--bg-depth) 100%)",
        }}
      />

      {/* Metallic gold line */}
      <div aria-hidden="true" className="gold-border-line bottom-0" />

      {/* Content — relative flow, padding clears header + creates cinematic space */}
      <div className="relative z-10 pt-32 sm:pt-36 md:pt-40 lg:pt-44 pb-32 sm:pb-40 md:pb-48 lg:pb-56">
        <h1 className="sr-only">Hyperia - The First AI-Native MMORPG</h1>
        <div className="max-w-6xl mx-auto container-padding w-full">
          <FadeIn onScroll={false} delay={0.1}>
            <div className="flex flex-col items-center md:items-start gap-6 md:gap-8 text-center md:text-left max-w-2xl hero-content-pedestal">
              <Image
                src="/images/hyperia-wordmark.svg"
                alt="Hyperia"
                width={960}
                height={180}
                className="w-64 sm:w-80 md:w-96 lg:w-[32rem] h-auto drop-shadow-[0_0_40px_var(--gold-glow-alt)]"
                priority
              />

              <p
                className="font-body text-lg sm:text-xl md:text-2xl lg:text-3xl max-w-sm md:max-w-lg lg:max-w-xl leading-relaxed"
                style={{ color: "var(--text-secondary)" }}
              >
                The first AI-native MMORPG where autonomous agents play
                alongside humans
              </p>

              <Button
                href={links.game}
                external
                variant="primary"
                className="text-base sm:text-lg px-8 sm:px-10 py-3.5 sm:py-4 animate-glow-pulse btn-sweep"
                aria-label="Play Now (opens in new tab)"
              >
                Play Now
              </Button>
            </div>
          </FadeIn>
        </div>
      </div>
    </section>
  );
}
