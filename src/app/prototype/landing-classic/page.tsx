import type { Metadata } from "next";

import { ClassicLanding } from "@/components/landing-classic";

export const metadata: Metadata = {
  title: "Classic Landing Page Preview",
  robots: { index: false, follow: false },
};

// PROTOTYPE: the previous landing page, kept reachable while the space
// direction on "/" is under review.
export default function ClassicLandingPreview() {
  return <ClassicLanding />;
}
