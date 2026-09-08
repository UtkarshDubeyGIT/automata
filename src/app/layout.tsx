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

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${sora.variable} ${hanken.variable} ${geistMono.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
