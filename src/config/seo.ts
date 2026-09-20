const DEFAULT_SITE_URL = "https://automata.doubtbuddy.com";

function canonicalSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_HOST || DEFAULT_SITE_URL;
  const withProtocol = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;

  try {
    return new URL(withProtocol).origin;
  } catch {
    return DEFAULT_SITE_URL;
  }
}

/** The public origin used in canonical URLs and crawler discovery files. */
export const SITE_URL = canonicalSiteUrl();
