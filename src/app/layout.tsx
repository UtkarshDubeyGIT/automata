import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";

import { BRAND } from "@/config/brand";

import "./globals.css";
import "./marketing.css";

const sora = localFont({ src: "./fonts/sora-latin.woff2", variable: "--font-sora", weight: "100 800", display: "swap" });
const hanken = localFont({ src: "./fonts/hanken-grotesk-latin.woff2", variable: "--font-hanken", weight: "100 900", display: "swap" });
const geistMono = localFont({ src: "./fonts/geist-mono-latin.woff2", variable: "--font-geist-mono", weight: "100 900", display: "swap" });

export const metadata: Metadata = {
  title: {
    default: `${BRAND.name} — ${BRAND.tagline}`,
    template: `%s · ${BRAND.name}`,
  },
  description: BRAND.description,
};

/**
 * Applies the saved theme before the browser paints.
 *
 * This has to be a blocking inline script: a React effect runs after first
 * paint, so the page would flash light before turning dark. It only ever ADDS
 * the class — <html> already carries the three next/font variable classes, and
 * assigning className would drop every font on the page.
 *
 * Keep the storage key in sync with THEME_STORAGE_KEY in src/components/theme.tsx.
 */
const THEME_BOOT = `(function(){try{var t=localStorage.getItem("automata:theme");var d=t==="dark"||((!t||t==="system")&&matchMedia("(prefers-color-scheme: dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){}})()`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    // suppressHydrationWarning: the boot script mutates the class list before
    // React hydrates, so server and client markup legitimately differ here.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sora.variable} ${hanken.variable} ${geistMono.variable} h-full`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
