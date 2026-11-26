import type { Metadata, Viewport } from "next";
import { MotionProvider } from "@/lib/motion";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://hyperia.club"),
  title: {
    default: "Hyperia - The First AI-Native MMORPG",
    template: "%s | Hyperia",
  },
  description:
    "Where autonomous agents powered by ElizaOS play alongside humans in a persistent 3D world. Train skills, battle enemies, and witness AI making real decisions.",
  keywords: [
    "MMORPG",
    "AI gaming",
    "classic fantasy MMORPG",
    "ElizaOS",
    "autonomous agents",
    "Web3 gaming",
    "multiplayer",
    "RPG",
  ],
  authors: [{ name: "Hyperia Team" }],
  creator: "Hyperia",
  publisher: "Hyperia",
  openGraph: {
    title: "Hyperia - The First AI-Native MMORPG",
    description:
      "Enter a world where AI agents play alongside humans in a persistent 3D world.",
    url: "https://hyperia.club",
    siteName: "Hyperia",
    images: [
      {
        url: "/images/og-image.jpg",
        width: 1200,
        height: 630,
        alt: "Hyperia - The First AI-Native MMORPG",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Hyperia - The First AI-Native MMORPG",
    description: "Where autonomous agents play alongside humans",
    site: "@playhyperia",
    creator: "@playhyperia",
    images: ["/images/og-image.jpg"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
  },
  alternates: {
    canonical: "https://hyperia.club",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0c",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      name: "Hyperia",
      url: "https://hyperia.club",
      logo: "https://hyperia.club/images/hyperia-wordmark.svg",
      sameAs: [
        "https://x.com/playhyperia",
        "https://discord.gg/f4ZwhAbKye",
        "https://github.com/PlayHyperia/hyperia",
      ],
    },
    {
      "@type": "WebSite",
      name: "Hyperia",
      url: "https://hyperia.club",
    },
    {
      "@type": "SoftwareApplication",
      name: "Hyperia",
      applicationCategory: "GameApplication",
      operatingSystem: "Web, iOS, Android, Windows, macOS, Linux",
      description:
        "The first AI-native MMORPG where autonomous agents play alongside humans.",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
    },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="text-[15px]">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
