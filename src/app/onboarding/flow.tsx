"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Avatar, Button, Chips, Field, Input, OptionCard, Skeleton, Textarea } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { StepChips } from "@/components/onboarding/step-chips";
import { AUDIENCES, PERSONAS, TONES, tintColors, toneByValue } from "@/lib/onboarding/taxonomy";
import type { BrandProfile, Persona } from "@/lib/brand";
import { cn } from "@/lib/utils";

const LABELS = ["You", "Website", "Role", "About", "Voice", "Done"] as const;
const LAST = LABELS.length - 1;

interface Answers {
  name: string;
  website: string;
  persona: Persona | "";
  audienceMode: "solo" | "team" | "";
  description: string;
  tone: string;
  audience: string;
}

export function OnboardingFlow({
  name,
  email,
  avatarUrl,
  profile,
}: {
  name: string;
  email: string;
  avatarUrl: string | null;
  profile: BrandProfile;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const { toast } = useToast();

  const resumeAt = Math.min(profile.onboarding?.step ?? 0, LAST);
  const fromUrl = Number(params.get("step"));
  const [step, setStep] = React.useState(
    Number.isInteger(fromUrl) && fromUrl >= 0 && fromUrl <= resumeAt ? fromUrl : resumeAt,
  );
  const [furthest, setFurthest] = React.useState(resumeAt);
  const [busy, setBusy] = React.useState(false);

  const [answers, setAnswers] = React.useState<Answers>({
    name,
    website: profile.website ?? "",
    persona: profile.persona ?? "",
    audienceMode: profile.audienceMode ?? "",
    description: profile.description ?? profile.analysis?.description ?? "",
    tone: profile.tone ?? "",
    audience: profile.audience ?? profile.analysis?.targetAudience ?? "",
  });

  const set = <K extends keyof Answers>(key: K, value: Answers[K]) =>
    setAnswers((a) => ({ ...a, [key]: value }));

  const [scraping, setScraping] = React.useState(false);
  const [fromSite, setFromSite] = React.useState({ description: false, audience: false });
  const [siteDomain, setSiteDomain] = React.useState("");
  // The URL we have already spent a scrape on. Blur fires on every tab in and
  // out of the field, and each run costs a Firecrawl fetch plus an OpenAI call.
  const analyzed = React.useRef(profile.website ?? "");
  // Read inside the async callback so the fill decision uses what the user has
  // typed by the time the scrape lands, not what was on screen when it started.
  // Synced in an effect rather than assigned during render — a ref written
  // while rendering is not a value React can be trusted to have committed.
  const answersRef = React.useRef(answers);
  React.useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  /**
   * Fired on blur, never awaited. The user is sent straight on to the Role step,
   * which takes long enough to pick that the answer is usually already sitting
   * on the About step by the time they reach it.
   */
  function analyze() {
    const raw = answers.website.trim();
    if (!raw || raw === analyzed.current) return;
    analyzed.current = raw;
    setScraping(true);
    void (async () => {
      try {
        const res = await fetch("/api/onboarding/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ website: raw }),
        });
        if (!res.ok) return;
        const data: {
          analysis?: { description?: string; targetAudience?: string } | null;
          website?: string;
        } = await res.json();
        if (data.website) {
          analyzed.current = data.website;
          setSiteDomain(data.website.replace(/^https?:\/\//, ""));
        }
        const found = data.analysis;
        if (!found) return;

        // Only ever fills a blank. Overwriting something the user typed would
        // be the site quietly outranking them, which is backwards.
        const current = answersRef.current;
        const fills: Partial<Answers> = {};
        if (!current.description.trim() && found.description) fills.description = found.description;
        if (!current.audience.trim() && found.targetAudience) fills.audience = found.targetAudience;
        if (Object.keys(fills).length) setAnswers((prev) => ({ ...prev, ...fills }));
        setFromSite({ description: Boolean(fills.description), audience: Boolean(fills.audience) });
      } catch {
        // Silence is the contract: a failed read leaves the field empty for the
        // user to fill, rather than guessing from the domain name.
      } finally {
        setScraping(false);
      }
    })();
  }

  const goTo = React.useCallback(
    (next: number) => {
      setStep(next);
      setFurthest((f) => Math.max(f, next));
      // replace, not push: the browser Back button should leave the flow, not
      // walk backwards through it one step at a time. The rail handles going back.
      router.replace(`/onboarding?step=${next}`, { scroll: false });
    },
    [router],
  );

  /** Only the fields that step owns, so going back cannot blank a later answer. */
  function valuesFor(index: number): Record<string, string> {
    switch (index) {
      case 0:
        return { name: answers.name };
      case 1:
        return { website: answers.website };
      case 2:
        return { persona: answers.persona, audienceMode: answers.audienceMode };
      case 3:
        return { description: answers.description };
      case 4:
        return { tone: answers.tone, audience: answers.audience };
      default:
        return {};
    }
  }

  async function post(url: string, body: unknown): Promise<boolean> {
    const res = await fetch(url, {
      method: url.endsWith("/step") ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return true;
    const data: { error?: string } = await res.json().catch(() => ({}));
    toast({ title: data.error ?? "Could not save. Please try again.", tone: "danger" });
    return false;
  }

  async function advance() {
    setBusy(true);
    try {
      if (!(await post("/api/onboarding/step", { step: step + 1, values: valuesFor(step) }))) return;
      goTo(step + 1);
    } catch {
      toast({ title: "Could not reach the server. Please try again.", tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function leave(skipped: boolean) {
    setBusy(true);
    try {
      // Finishing saves the last screen's answers first; skipping deliberately
      // does not, and writes no defaults in their place.
      if (!skipped && !(await post("/api/onboarding/step", { step, values: valuesFor(step) }))) return;
      if (!(await post("/api/onboarding/complete", { skipped, step }))) return;
      router.replace("/app/workflows");
      router.refresh();
    } catch {
      toast({ title: "Could not reach the server. Please try again.", tone: "danger" });
      setBusy(false);
    }
  }

  const business = answers.audienceMode === "team";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-6 py-10 md:py-14">
      <StepChips labels={LABELS} current={step} furthest={furthest} onJump={goTo} />

      <div key={step} className="mt-12 flex-1" style={{ animation: "ob-rise 0.24s var(--ease-out)" }}>
        {step === 0 && (
          <Step title="What should we call you?" subtitle="This is the name your workspace and your AI steps use.">
            <div className="flex items-center gap-3 rounded-card border border-line bg-inset p-3">
              <Avatar name={answers.name || email} src={avatarUrl} size="lg" />
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-medium text-ink">{answers.name || "Signed in"}</p>
                <p className="truncate text-[12px] text-ink-subtle">{email}</p>
              </div>
            </div>
            <Field label="Your name" htmlFor="ob-name" className="mt-5">
              <Input id="ob-name" value={answers.name} onChange={(e) => set("name", e.target.value)} placeholder="Your name" autoFocus />
            </Field>
          </Step>
        )}

        {step === 1 && (
          <Step title="Do you have a website?" subtitle="We read the homepage once to fill in the next couple of answers. Optional — you can skip this and type them yourself.">
            <Field label="Website" htmlFor="ob-website" hint="We only read what is publicly on the page.">
              <Input
                id="ob-website"
                value={answers.website}
                onChange={(e) => set("website", e.target.value)}
                onBlur={analyze}
                placeholder="yourcompany.com"
                inputMode="url"
                autoFocus
              />
            </Field>
          </Step>
        )}

        {step === 2 && (
          <Step title="Which sounds most like you?" subtitle="This helps us suggest the right automations later.">
            <div role="radiogroup" aria-label="Your role" className="grid gap-2 sm:grid-cols-2">
              {PERSONAS.map((p) => (
                <OptionCard
                  key={p.id}
                  name="ob-persona"
                  selected={answers.persona === p.id}
                  onSelect={() => set("persona", p.id)}
                  icon={p.icon}
                  label={p.label}
                  description={p.description}
                  tint={tintColors(p.tint)}
                />
              ))}
            </div>
            <div className="mt-6 border-t border-line pt-5">
              <p className="text-[13px] font-medium text-ink">Are you on your own, or with others?</p>
              <p className="mt-0.5 text-[12px] text-ink-subtle">
                This decides whether your AI writes &ldquo;I&rdquo; or &ldquo;we&rdquo;.
              </p>
              <Chips
                className="mt-3"
                items={[
                  { id: "solo", label: "Just me" },
                  { id: "team", label: "I have a team or company" },
                ]}
                value={answers.audienceMode}
                onChange={(id) => set("audienceMode", answers.audienceMode === id ? "" : (id as "solo" | "team"))}
              />
            </div>
          </Step>
        )}

        {step === 3 && (
          <Step
            title={business ? "What does your business do?" : "What do you do?"}
            subtitle="A sentence or two. Every AI step writes from this, so plain and specific beats polished."
          >
            {scraping && !answers.description ? (
              <div className="flex flex-col gap-2" aria-live="polite">
                <span className="text-[13px] font-medium text-ink">Reading {siteDomain || "your site"}…</span>
                <Skeleton className="h-[120px] w-full" rounded="control" />
              </div>
            ) : (
              <Field
                label={business ? "About your business" : "About your work"}
                htmlFor="ob-description"
                hint={
                  fromSite.description && siteDomain
                    ? `Pulled from ${siteDomain} — edit if that is not right.`
                    : undefined
                }
              >
                <Textarea
                  id="ob-description"
                  rows={5}
                  value={answers.description}
                  onChange={(e) => {
                    set("description", e.target.value);
                    if (fromSite.description) setFromSite((f) => ({ ...f, description: false }));
                  }}
                  placeholder={business ? "We help D2C brands automate their post-purchase email." : "I design and build websites for small studios."}
                  autoFocus
                />
              </Field>
            )}
          </Step>
        )}

        {step === 4 && (
          <Step title="How should your AI sound?" subtitle="Pick the closest. You can rewrite it any time in Settings.">
            <div role="radiogroup" aria-label="Tone of voice" className="grid gap-2 sm:grid-cols-2">
              {TONES.map((t) => (
                <OptionCard
                  key={t.id}
                  name="ob-tone"
                  selected={answers.tone === t.value}
                  onSelect={() => set("tone", t.value)}
                  icon={t.icon}
                  label={t.label}
                  description={t.description}
                  tint={tintColors(t.tint)}
                />
              ))}
            </div>
            <div className="mt-6 border-t border-line pt-5">
              <p className="text-[13px] font-medium text-ink">Who is reading?</p>
              <p className="mt-0.5 text-[12px] text-ink-subtle">Optional.</p>
              <Chips
                className="mt-3"
                items={AUDIENCES.map((a) => ({ id: a, label: a }))}
                value={answers.audience}
                onChange={(id) => {
                  set("audience", answers.audience === id ? "" : id);
                  if (fromSite.audience) setFromSite((f) => ({ ...f, audience: false }));
                }}
              />
              {answers.audience && !AUDIENCES.includes(answers.audience) ? (
                // The site described an audience in its own words, which no chip
                // matches. Showing it beats silently holding a value the row
                // renders as "nothing selected".
                <p className="mt-3 text-[12px] text-ink-subtle">
                  Currently: <span className="text-ink">{answers.audience}</span>
                  {fromSite.audience && siteDomain ? ` — from ${siteDomain}` : ""}
                </p>
              ) : null}
            </div>
          </Step>
        )}

        {step === LAST && (
          <Step title="Got it." subtitle="Here is what your AI steps will work from. All of it is editable in Settings.">
            <dl className="divide-y divide-line rounded-card border border-line bg-card">
              <Summary term="Name" value={answers.name} />
              <Summary term="Website" value={answers.website} />
              <Summary term="Role" value={PERSONAS.find((p) => p.id === answers.persona)?.label ?? ""} />
              <Summary term={business ? "Business" : "Work"} value={answers.description} />
              <Summary term="Voice" value={toneByValue(answers.tone)?.label ?? ""} />
              <Summary term="Audience" value={answers.audience} />
            </dl>
          </Step>
        )}
      </div>

      <div className="mt-10 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => void leave(true)}
          disabled={busy}
          className="text-[13px] text-ink-subtle underline-offset-4 transition-colors hover:text-ink hover:underline disabled:opacity-60"
        >
          Skip setup
        </button>
        <div className="flex items-center gap-2">
          {step > 0 && step < LAST && (
            <Button variant="ghost" onClick={() => goTo(step - 1)} disabled={busy}>
              Back
            </Button>
          )}
          {step < LAST ? (
            <Button onClick={() => void advance()} loading={busy} iconRight="arrow-right">
              Continue
            </Button>
          ) : (
            <Button onClick={() => void leave(false)} loading={busy} iconRight="arrow-right">
              Start using Automata
            </Button>
          )}
        </div>
      </div>

      {/* The house pattern for entrances — there is no animation library, and
          globals.css already kills this under prefers-reduced-motion. */}
      <style>{`@keyframes ob-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
    </main>
  );
}

function Step({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section>
      <h1 className="text-[30px] font-semibold leading-[1.15] tracking-tight text-ink md:text-[34px]">{title}</h1>
      <p className="mt-3 max-w-lg text-[14.5px] leading-relaxed text-ink-subtle">{subtitle}</p>
      <div className="mt-8">{children}</div>
    </section>
  );
}

function Summary({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex gap-4 px-4 py-3">
      <dt className="w-24 flex-none text-[12.5px] text-ink-subtle">{term}</dt>
      <dd className={cn("min-w-0 flex-1 text-[13.5px]", value ? "text-ink" : "text-ink-disabled")}>
        {value || "Not set"}
      </dd>
    </div>
  );
}
