import { SpaceLanding } from "@/components/landing-space/space-landing";

/**
 * Landing page mock: the space-themed direction drawn from the sign-in panel.
 *
 * To switch back to the previous landing, swap the import for
 * `ClassicLanding` from "@/components/landing-classic". Both stay side by
 * side until one is chosen; the classic one is viewable at
 * /prototype/landing-classic in the meantime.
 */
export default function LandingPage() {
  return <SpaceLanding />;
}
