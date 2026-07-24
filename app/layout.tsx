import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { PwaRegistration } from "./pwa-registration";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

const BUILD_SHA = resolveBuildProvenance();
const SITE_ORIGIN = resolveSiteOrigin();

export const metadata: Metadata = {
  metadataBase: SITE_ORIGIN,
  title: "FieldProof · Outcome operations for pest control",
  description:
    "Reduce reservice, prove service quality, improve route economics, and grow contribution profit per technician-day.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "FieldProof",
    description: "Every service visit should make the next one smarter.",
    type: "website",
    url: SITE_ORIGIN,
    images: [
      {
        url: new URL("/og.png", SITE_ORIGIN),
        width: 800,
        height: 418,
        alt: "FieldProof outcome operations",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "FieldProof",
    description: "Every service visit should make the next one smarter.",
    images: [new URL("/og.png", SITE_ORIGIN)],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-build-sha={BUILD_SHA}>
      <body className={`${inter.variable} ${mono.variable}`}>
        {children}
        <PwaRegistration />
      </body>
    </html>
  );
}

function resolveBuildProvenance() {
  const candidates = [
    process.env.FIELDPROOF_BUILD_SHA,
    process.env.SOURCE_COMMIT_SHA,
    process.env.GITHUB_SHA,
    process.env.CF_PAGES_COMMIT_SHA,
  ];
  return (
    candidates.find(
      (value): value is string =>
        typeof value === "string" &&
        /^[a-f0-9]{40,64}$/i.test(value),
    ) ??
    (process.env.NODE_ENV === "production"
      ? "unverified"
      : "development")
  );
}

function resolveSiteOrigin() {
  const candidates = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.SITE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.hostname === "localhost") {
        return url;
      }
    } catch {
      // Ignore malformed deployment configuration and use the safe fallback.
    }
  }
  return new URL("http://localhost:3001");
}
