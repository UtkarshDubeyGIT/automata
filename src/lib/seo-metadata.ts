import type { Metadata } from "next";

import { BRAND } from "@/config/brand";
import { SITE_URL } from "@/config/seo";

const SHARE_IMAGE = `${SITE_URL}/opengraph-image`;

export function publicPageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): Metadata {
  const pageUrl = new URL(path, SITE_URL).toString();
  const socialTitle = `${title} | ${BRAND.name}`;

  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      locale: "en_US",
      url: pageUrl,
      siteName: BRAND.name,
      title: socialTitle,
      description,
      images: [{ url: SHARE_IMAGE, width: 1200, height: 630, alt: "Automata AI workflow automation" }],
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      images: [SHARE_IMAGE],
    },
  };
}
