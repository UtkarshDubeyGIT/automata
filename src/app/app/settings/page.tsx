"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/app-shell/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea, Select } from "@/components/ui/form";
import { Segmented } from "@/components/ui/tabs";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { SignOutButton } from "@/components/sign-out-button";
import { WhatsAppSettings } from "@/components/whatsapp-settings";
import { NotificationSettings } from "@/components/notification-settings";
import { BrandVoiceLearning } from "@/components/brand-voice-learning";
import { PERSONAS, TONES } from "@/lib/onboarding/taxonomy";

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "brand", label: "Brand voice" },
  { id: "workspace", label: "Workspace" },
  { id: "channels", label: "Channel data" },
  { id: "notifications", label: "Notifications" },
];

/** What the settings API round-trips. */
interface Settings {
  company: string;
  website: string;
  description: string;
  tone: string;
  audience: string;
  voiceGuidelines: string;
  language: string;
  metaAdAccountId: string;
  googleAdsCustomerId: string;
  ga4PropertyId: string;
  linkedinOrganizationId: string;
  /** IANA zone every scheduled automation is expressed in. */
  timezone: string;
  persona: string;
  audienceMode: string;
}

/**
 * Which tier answered for a field, derived by the API rather than stored.
 * "site" means the value came off the workspace's homepage and the user has
 * never confirmed it, which is worth saying out loud before it grounds every
 * generated post.
 */
type FieldSource = "user" | "site" | "none";

/** GET /api/settings: the workspace's brand profile plus who is signed in. */
interface Loaded {
  settings?: Settings;
  sources?: Partial<Record<"description" | "tone" | "audience", FieldSource>>;
  email?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
}

const EMPTY: Settings = {
  company: "",
  website: "",
  description: "",
  tone: "",
  audience: "",
  voiceGuidelines: "",
  language: "English",
  metaAdAccountId: "",
  googleAdsCustomerId: "",
  ga4PropertyId: "",
  linkedinOrganizationId: "",
  timezone: "UTC",
  persona: "",
  audienceMode: "",
};

/**
 * The zones offered in the picker, plus whatever the browser reports, so the
 * common answer is one click away and every other zone is still reachable.
 * Deliberately short: this is a scheduling detail, not a geography quiz.
 */
const TIMEZONES = [
  "UTC",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
];

export default function SettingsPage() {
  const { toast } = useToast();
  const router = useRouter();
  const [tab, setTab] = useState("profile");
  const [loadError, setLoadError] = useState("");

  // Real values, loaded from the workspace brand profile.
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [email, setEmail] = useState("");
  // The signed-in person, kept apart from `settings` because those describe the
  // business: the company name is not who you are logged in as.
  const [account, setAccount] = useState<{ name: string; avatarUrl: string | null }>({
    name: "",
    avatarUrl: null,
  });
  const [sources, setSources] = useState<Partial<Record<string, FieldSource>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  /**
   * The hint under a field we read off the site. It disappears as soon as the
   * value is edited, because at that point it is the user's answer.
   */
  function siteHint(field: string, fallback?: string) {
    return sources[field] === "site" ? "Pulled from your website — edit if that is not right." : fallback;
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Could not load your settings.");
        return data;
      })
      .then((d: Loaded | null) => {
        if (cancelled) return;
        if (d?.settings) setSettings({ ...EMPTY, ...d.settings });
        if (d?.sources) setSources(d.sources);
        if (d?.email) setEmail(d.email);
        setAccount({ name: d?.name ?? "", avatarUrl: d?.avatarUrl ?? null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Could not load your settings.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((s) => ({ ...s, [key]: value }));
    // Once it has been touched it is no longer just what the site said.
    setSources((prev) => (prev[key] === "site" ? { ...prev, [key]: "user" } : prev));
  }

  /**
   * Persist. Sends only the fields the open tab owns, so saving one tab can
   * never overwrite another with stale values.
   */
  async function save(fields: (keyof Settings)[]) {
    setSaving(true);
    try {
      const patch: Partial<Settings> = {};
      for (const f of fields) patch[f] = settings[f] as never;
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        toast({ title: "Couldn't save", description: d?.error, tone: "danger" });
        return;
      }
      toast({ title: "Settings saved", tone: "success" });
      router.refresh();
    } catch {
      toast({ title: "Couldn't save", description: "Please try again.", tone: "danger" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader title="Settings" subtitle="Your account, brand profile, and preferences." />

      <div className="min-w-0 overflow-x-auto pb-1"><Segmented items={TABS} value={tab} onChange={setTab} className="whitespace-nowrap" /></div>
      {loadError && <Card className="border-danger-border bg-danger-surface p-4 text-[14px] text-danger" role="alert">{loadError}</Card>}

      {tab === "profile" && (
        <Card className="min-w-0 p-4 sm:p-6">
          <CardHeader title="Profile" subtitle="Your business and the context your automations use." />
          <div className="mt-6 flex items-center gap-4">
            <Avatar
              name={account.name || settings.company || email || "You"}
              src={account.avatarUrl}
              size="lg"
            />
            <div className="min-w-0 break-words text-[13px] text-ink-subtle">
              Signed in as{" "}
              <span className="font-medium text-ink">{email || "—"}</span>
            </div>
          </div>
          <div className="mt-6 grid min-w-0 max-w-xl grid-cols-1 gap-4">
            <Field label="Company" htmlFor="settings-company" hint="Used by automations that write about your product.">
              <Input
                id="settings-company" value={settings.company}
                disabled={loading || !!loadError}
                onChange={(e) => set("company", e.target.value)}
              />
            </Field>
            <Field
              label="Content language" htmlFor="settings-language"
              hint="Every generated script, caption and voiceover is written in this language."
            >
              <Input
                id="settings-language" value={settings.language}
                disabled={loading || !!loadError}
                placeholder="English"
                onChange={(e) => set("language", e.target.value)}
              />
            </Field>
            <Field label="Website" htmlFor="settings-website">
              <Input id="settings-website" value={settings.website} disabled={loading || !!loadError} placeholder="https://your-company.com" onChange={(e) => set("website", e.target.value)} />
            </Field>
            <Field
              label={settings.audienceMode === "solo" ? "What do you do?" : "What does your business do?"}
              htmlFor="settings-description"
              hint={siteHint("description", "Describe your product, what makes it useful, and the customers you help.")}
            >
              <Textarea id="settings-description" rows={4} value={settings.description} disabled={loading || !!loadError} placeholder="We help teams..." onChange={(e) => set("description", e.target.value)} />
            </Field>
            <Field label="Which sounds most like you?" htmlFor="settings-persona" hint="Used to suggest automations that fit how you work.">
              <Select id="settings-persona" value={settings.persona} disabled={loading || !!loadError} onChange={(e) => set("persona", e.target.value)}>
                <option value="">Not set</option>
                {PERSONAS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label} — {p.description}</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="mt-6">
            <Button loading={saving} disabled={loading || !!loadError} onClick={() => save(["company", "language", "website", "description", "persona"])}>
              Save changes
            </Button>
          </div>
        </Card>
      )}

      {tab === "brand" && (
        <Card className="min-w-0 p-4 sm:p-6">
          <CardHeader title="Brand voice" subtitle="Your AI steps use this voice." />
          <div className="mt-6 grid min-w-0 max-w-xl grid-cols-1 gap-4">
            <Field label="Default tone" htmlFor="settings-tone" hint={siteHint("tone")}>
              <Select
                id="settings-tone" value={settings.tone}
                disabled={loading || !!loadError}
                onChange={(e) => set("tone", e.target.value)}
              >
                {/* Anything not offered below — a legacy value, or a sentence
                    read off the site — stays selectable rather than silently
                    resetting to the first option on the next save. */}
                {!TONES.some((t) => t.value === settings.tone) && (
                  <option value={settings.tone}>{settings.tone || "Choose a tone"}</option>
                )}
                {TONES.map((t) => (
                  <option key={t.id} value={t.value}>{t.label} — {t.description}</option>
                ))}
              </Select>
            </Field>
            <Field
              label="Are you on your own, or with others?"
              htmlFor="settings-audienceMode"
              hint="Decides whether your AI writes “I” or “we”."
            >
              <Select
                id="settings-audienceMode" value={settings.audienceMode}
                disabled={loading || !!loadError}
                onChange={(e) => set("audienceMode", e.target.value)}
              >
                <option value="">Not set</option>
                <option value="solo">Just me</option>
                <option value="team">I have a team or company</option>
              </Select>
            </Field>
            <Field label="Who is your audience?" htmlFor="settings-audience" hint={siteHint("audience")}>
              <Input
                id="settings-audience" value={settings.audience}
                disabled={loading || !!loadError}
                placeholder="Indie hackers and solo founders shipping AI products"
                onChange={(e) => set("audience", e.target.value)}
              />
            </Field>
            <Field label="Voice guidelines" htmlFor="settings-voiceGuidelines" hint="Rules your automations follow when writing.">
              <Textarea
                rows={4}
                id="settings-voiceGuidelines" value={settings.voiceGuidelines}
                disabled={loading || !!loadError}
                placeholder="Confident, plain-spoken, founder-to-founder. Sentence case. Lead with specifics. No hype words, no emoji."
                onChange={(e) => set("voiceGuidelines", e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-6">
            <Button
              loading={saving}
              disabled={loading || !!loadError}
              onClick={() => save(["tone", "audience", "voiceGuidelines", "audienceMode"])}
            >
              Save brand voice
            </Button>
          </div>
          <BrandVoiceLearning website={settings.website} disabled={loading || !!loadError} />
        </Card>
      )}

      {tab === "workspace" && (
        <Card className="min-w-0 p-4 sm:p-6">
          <CardHeader title="Workspace" subtitle="Your organization settings." />
          <div className="mt-6 grid min-w-0 max-w-xl grid-cols-1 gap-4">
            <Field label="Workspace name" htmlFor="settings-company" hint="Also the company name your agents write about.">
              <Input
                id="settings-company" value={settings.company}
                disabled={loading || !!loadError}
                onChange={(e) => set("company", e.target.value)}
              />
            </Field>
            <Field
              label="Time zone" htmlFor="settings-timezone"
              hint="What “every day at 9am” means for your automations."
            >
              <Select
                id="settings-timezone" value={settings.timezone}
                disabled={loading || !!loadError}
                onChange={(e) => set("timezone", e.target.value)}
              >
                {[
                  ...new Set([
                    ...TIMEZONES,
                    settings.timezone,
                    Intl.DateTimeFormat().resolvedOptions().timeZone,
                  ]),
                ]
                  .filter(Boolean)
                  .sort()
                  .map((zone) => (
                    <option key={zone} value={zone}>
                      {zone.replace(/_/g, " ")}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <div className="mt-6">
            <Button
              loading={saving}
              disabled={loading || !!loadError}
              onClick={() => save(["company", "timezone"])}
            >
              Save workspace
            </Button>
          </div>
        </Card>
      )}

      {tab === "channels" && (
        <Card className="min-w-0 p-4 sm:p-6">
          <CardHeader
            title="Channel data"
            subtitle="Account identifiers available to your connected workflows."
            icon={<Icon name="gauge" size={18} />}
          />
          <div className="mt-6 grid min-w-0 max-w-xl grid-cols-1 gap-4">
            <Field
              label="Meta ad account id" htmlFor="settings-metaAdAccountId"
              hint="Found in Meta Ads Manager, e.g. act_1234567890 (the act_ prefix is optional)."
            >
              <Input
                id="settings-metaAdAccountId" value={settings.metaAdAccountId}
                disabled={loading || !!loadError}
                placeholder="act_1234567890"
                onChange={(e) => set("metaAdAccountId", e.target.value)}
              />
            </Field>
            <Field
              label="Google Ads customer id" htmlFor="settings-googleAdsCustomerId"
              hint="The 10-digit id at the top of your Google Ads account. Only needed if you manage more than one."
            >
              <Input
                id="settings-googleAdsCustomerId" value={settings.googleAdsCustomerId}
                disabled={loading || !!loadError}
                placeholder="123-456-7890"
                onChange={(e) => set("googleAdsCustomerId", e.target.value)}
              />
            </Field>
            <Field
              label="Google Analytics property id" htmlFor="settings-ga4PropertyId"
              hint="Admin → Property settings, e.g. 123456789. Only needed if your Google account has more than one property."
            >
              <Input
                id="settings-ga4PropertyId" value={settings.ga4PropertyId}
                disabled={loading || !!loadError}
                placeholder="123456789"
                onChange={(e) => set("ga4PropertyId", e.target.value)}
              />
            </Field>
            <Field
              label="LinkedIn organization id" htmlFor="settings-linkedinOrganizationId"
              hint="The numeric organization id from your LinkedIn company page URL. Required to sync company followers."
            >
              <Input
                id="settings-linkedinOrganizationId" value={settings.linkedinOrganizationId}
                disabled={loading || !!loadError}
                inputMode="numeric"
                placeholder="123456789"
                onChange={(e) => set("linkedinOrganizationId", e.target.value)}
              />
            </Field>
          </div>
          {/* Only Meta's id is mandatory. The other two are tie-breakers: both
              APIs CAN list what the login can reach, but an agency login
              reaches other people's businesses, so we ask rather than pick. */}
          <p className="mt-4 flex max-w-xl items-start gap-2 text-[12.5px] leading-relaxed text-ink-subtle">
            <Icon name="info" size={14} className="mt-0.5 flex-none" />
            These identifiers select the account your automations should use. Connect the corresponding app in Integrations to authorize access.
          </p>
          <div className="mt-6">
            <Button
              loading={saving}
              disabled={loading || !!loadError}
              onClick={() =>
                save([
                  "metaAdAccountId",
                  "googleAdsCustomerId",
                  "ga4PropertyId",
                  "linkedinOrganizationId",
                ])
              }
            >
              Save channel data
            </Button>
          </div>
        </Card>
      )}

      {tab === "notifications" && (
        <Card className="min-w-0 p-4 sm:p-6">
          <CardHeader title="Notifications" subtitle="Receive workflow approvals and reminders on WhatsApp." />
          <div className="mt-6 flex max-w-2xl flex-col gap-8">
            <NotificationSettings />
            <div className="border-t border-line pt-8">
              <WhatsAppSettings />
            </div>
          </div>
        </Card>
      )}

      {/* Danger / account */}
      <Card className="min-w-0 p-4 sm:p-6">
        <CardHeader
          title="Account"
          subtitle="Sign out or manage account access."
          icon={<Icon name="shield" size={18} />}
        />
        <div className="mt-5 flex gap-3">
          <SignOutButton />
        </div>
      </Card>
    </div>
  );
}
