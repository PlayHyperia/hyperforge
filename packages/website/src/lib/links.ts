/**
 * External links configuration
 * Uses environment variables with fallbacks
 */

function resolvePublicHttpsUrl(
  name: string,
  configuredValue: string | undefined,
  fallback: string,
): string {
  const rawValue = configuredValue?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error(`${name} must be a valid public HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(
      `${name} must be a public HTTPS URL without credentials or a fragment`,
    );
  }
  return parsed.toString();
}

export const links = {
  docs: process.env.NEXT_PUBLIC_DOCS_URL || "https://hyperia-ai.mintlify.app/",
  game: process.env.NEXT_PUBLIC_GAME_URL || "https://hyperia.gg",
  hyperbet: resolvePublicHttpsUrl(
    "NEXT_PUBLIC_HYPERBET_URL",
    process.env.NEXT_PUBLIC_HYPERBET_URL,
    "https://hyperia.bet",
  ),
  discord:
    process.env.NEXT_PUBLIC_DISCORD_URL || "https://discord.gg/f4ZwhAbKye",
  twitter: process.env.NEXT_PUBLIC_TWITTER_URL || "https://x.com/playhyperia",
  github:
    process.env.NEXT_PUBLIC_GITHUB_URL ||
    "https://github.com/PlayHyperia/hyperia",
};

export const navigation = {
  header: [
    { label: "Docs", href: links.docs, external: true },
    { label: "Discord", href: links.discord, external: true, icon: "discord" },
    { label: "Twitter", href: links.twitter, external: true, icon: "twitter" },
  ],
  footer: {
    game: [
      { label: "Play Now", href: links.game, external: true },
      { label: "Duel Arena", href: links.hyperbet, external: true },
      { label: "Documentation", href: links.docs, external: true },
      { label: "Roadmap", href: `${links.docs}changelog/`, external: true },
    ],
    community: [
      { label: "Discord", href: links.discord, external: true },
      { label: "Twitter/X", href: links.twitter, external: true },
      { label: "GitHub", href: links.github, external: true },
    ],
    resources: [
      { label: "Documentation", href: links.docs, external: true },
      {
        label: "API Reference",
        href: `${links.docs}api-reference/`,
        external: true,
      },
      { label: "GitHub", href: links.github, external: true },
    ],
  },
};
