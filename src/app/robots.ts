import type { MetadataRoute } from "next";

import { SITE_URL } from "@/config/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // HTML routes carry a noindex directive so crawlers can see it. Keep
      // machine endpoints and token URLs out of crawler discovery.
      disallow: ["/api/", "/auth/", "/hooks/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
