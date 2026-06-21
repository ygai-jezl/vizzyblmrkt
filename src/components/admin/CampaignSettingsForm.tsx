"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CampaignSettings } from "@/lib/admin/campaignSettings";
import type { EmailSenderConfig } from "@/lib/types/tenant";

const CONTACT_OPTIONS: { value: CampaignSettings["requiredContactDetail"]; label: string }[] = [
  { value: "EMAIL", label: "Email only" },
  { value: "PHONE", label: "Phone only" },
  { value: "BOTH", label: "Email and phone" },
  { value: "EITHER", label: "Email or phone" },
];

type Strategy = CampaignSettings["strategy"];
type AiConversation = CampaignSettings["aiConversation"];
type OffboardingEmail = CampaignSettings["offboardingEmail"];

const CAMPAIGN_GOAL_OPTIONS: { value: Strategy["campaignGoal"]; label: string }[] = [
  { value: "PRE_LAUNCH_WAITLIST", label: "Build Pre-Launch Waitlist" },
  { value: "ENTERPRISE_LEAD_GEN", label: "Enterprise Lead Generation" },
  { value: "COHORT_WAVE_RELEASE", label: "Cohort Access Wave Release" },
  { value: "GENERAL_AVAILABILITY", label: "Direct Product Launch / GA" },
  { value: "EVENT_REGISTRATION", label: "Event / Webinar Registration" },
];

const TARGET_AUDIENCE_OPTIONS: { value: Strategy["targetAudience"]; label: string }[] = [
  { value: "DEVELOPERS_TECHNICAL_FOUNDERS", label: "Developers & Technical Founders" },
  { value: "ENTERPRISE_DECISION_MAKERS", label: "Enterprise Decision Makers" },
  { value: "STARTUPS_INDIE_HACKERS", label: "Startups & Indie Hackers" },
  { value: "PRODUCT_GROWTH_TEAMS", label: "Product & Growth Teams" },
  { value: "GENERAL_CONSUMERS", label: "General Consumers" },
];

const BRAND_TONE_OPTIONS: { value: Strategy["brandTone"]; label: string }[] = [
  { value: "TECHNICAL_PEER", label: "Developer-to-Developer" },
  { value: "BOLD_CHALLENGER", label: "Bold & Disruptive" },
  { value: "ENTERPRISE_TRUST", label: "Enterprise Polish" },
  { value: "PRODUCT_LED_CASUAL", label: "Product-Led Casual" },
  { value: "FOMO_EXCLUSIVE", label: "High-Scarcity FOMO" },
];

/** Lenient single-address email check for the optional sender overrides. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Stable per-row id so React keys survive add/remove (no focus loss). */
const uid = () => crypto.randomUUID();

/** UI representation of a survey question (options edited as one-per-line text). */
interface UiQuestion {
  id: string;
  question_value: string;
  optional: boolean;
  isChoice: boolean;
  optionsText: string;
}

function toUiQuestions(settings: CampaignSettings): UiQuestion[] {
  return settings.questions.map((q) => ({
    id: uid(),
    question_value: q.question_value,
    optional: q.optional,
    isChoice: q.answer_value !== null,
    optionsText: q.answer_value ? q.answer_value.join("\n") : "",
  }));
}

export function CampaignSettingsForm({
  campaignId,
  initial,
  senderConfig,
}: {
  campaignId: string;
  initial: CampaignSettings;
  senderConfig: EmailSenderConfig;
}) {
  const router = useRouter();
  const [form, setForm] = useState<CampaignSettings>(initial);
  const [questions, setQuestions] = useState<UiQuestion[]>(() => toUiQuestions(initial));
  // Probe topics edited as a one-per-line textarea (mirrors question options).
  const [probeTopicsText, setProbeTopicsText] = useState(
    () => initial.aiConversation.probeTopics?.join("\n") ?? "",
  );
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errors, setErrors] = useState<string[]>([]);

  function set<K extends keyof CampaignSettings>(key: K, value: CampaignSettings[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
    setStatus("idle");
  }
  function setStrategy<K extends keyof Strategy>(key: K, value: Strategy[K]) {
    setForm((f) => ({
      ...f,
      strategy: { ...f.strategy, [key]: value },
    }));
    setDirty(true);
    setStatus("idle");
  }
  function setAiConversation<K extends keyof AiConversation>(key: K, value: AiConversation[K]) {
    setForm((f) => ({
      ...f,
      aiConversation: { ...f.aiConversation, [key]: value },
    }));
    setDirty(true);
    setStatus("idle");
  }
  function setOffboardingEmail<K extends keyof OffboardingEmail>(
    key: K,
    value: OffboardingEmail[K],
  ) {
    setForm((f) => ({
      ...f,
      offboardingEmail: { ...f.offboardingEmail, [key]: value },
    }));
    setDirty(true);
    setStatus("idle");
  }
  function setProbeTopicsAndDirty(text: string) {
    setProbeTopicsText(text);
    setDirty(true);
    setStatus("idle");
  }
  function setQuestionsAndDirty(next: UiQuestion[]) {
    setQuestions(next);
    setDirty(true);
    setStatus("idle");
  }
  function updateQuestion(i: number, patch: Partial<UiQuestion>) {
    setQuestionsAndDirty(questions.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
  }

  /**
   * Client-side checks for the optional sender overrides so a malformed address
   * is caught inline rather than only by the server schema. Returns
   * human-readable errors; empty = ok. (Branding/colours now live in the Embed &
   * Design tab, which validates its own fields.)
   */
  function validate(): string[] {
    const errs: string[] = [];
    const addr = form.emailFromAddress?.trim();
    if (addr && !EMAIL_RE.test(addr)) {
      errs.push("From address must be a valid email like hello@mail.yourbrand.com.");
    }
    const reply = form.emailReplyTo?.trim();
    if (reply && !EMAIL_RE.test(reply)) {
      errs.push("Reply-to must be a valid email address.");
    }
    return errs;
  }

  /** Build the wire payload. The server schema re-validates and normalises. */
  function buildPayload(): CampaignSettings {
    return {
      ...form,
      waitlistName: form.waitlistName.trim(),
      waitlistUrlLocation: form.waitlistUrlLocation?.trim() ? form.waitlistUrlLocation.trim() : null,
      // Send an explicit "" (never undefined) so clearing the message actually
      // overwrites the stored value — Firestore update() is a merge and would
      // otherwise keep the old copy.
      twitterMessage: form.twitterMessage?.trim() ?? "",
      // Branding (colours, copy, social links) now lives in the Embed & Design
      // tab. Pass configurationStyleJson straight through so this form never
      // clobbers values that tab owns.
      configurationStyleJson: form.configurationStyleJson,
      // Send an explicit "" (never undefined) so clearing the instructions
      // overwrites the stored value (Firestore update() merges otherwise).
      strategy: {
        ...form.strategy,
        customToneInstructions: form.strategy.customToneInstructions?.trim() ?? "",
      },
      // Same merge gotcha: send explicit ""/[] for cleared conversation fields.
      aiConversation: {
        ...form.aiConversation,
        introLine: form.aiConversation.introLine?.trim() ?? "",
        conversationGoal: form.aiConversation.conversationGoal?.trim() ?? "",
        probeTopics: probeTopicsText
          .split("\n")
          .map((t) => t.trim())
          .filter(Boolean),
      },
      // Send explicit "" for cleared subject/body so the merge update overwrites.
      offboardingEmail: {
        ...form.offboardingEmail,
        subject: form.offboardingEmail.subject?.trim() ?? "",
        body: form.offboardingEmail.body?.trim() ?? "",
      },
      questions: questions.map((q) => ({
        question_value: q.question_value.trim(),
        optional: q.optional,
        answer_value: q.isChoice
          ? q.optionsText.split("\n").map((o) => o.trim()).filter(Boolean)
          : null,
      })),
    };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const clientErrors = validate();
    if (clientErrors.length > 0) {
      setErrors(clientErrors);
      setStatus("error");
      return;
    }
    setStatus("saving");
    setErrors([]);
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const issues = Array.isArray(data.issues)
          ? data.issues.map((i: unknown) =>
              typeof i === "string" ? i : `${(i as { path?: string }).path ?? ""}: ${(i as { message?: string }).message ?? ""}`,
            )
          : [data.error ?? "Save failed."];
        setErrors(issues);
        setStatus("error");
        return;
      }
      // Re-seed from the SERVER-NORMALISED settings so the editor shows exactly
      // what was persisted (e.g. an empty multiple-choice collapsed to free-text).
      if (data.settings) {
        const settings = data.settings as CampaignSettings;
        setForm(settings);
        setQuestions(toUiQuestions(settings));
        setProbeTopicsText(settings.aiConversation.probeTopics?.join("\n") ?? "");
      }
      setDirty(false);
      setStatus("saved");
      router.refresh();
    } catch {
      setErrors(["Network error — please try again."]);
      setStatus("error");
    }
  }

  // Domains the tenant can actually send from (verified at the provider). Only
  // these may back a custom From address — see resolveSender in lib/email.
  const verifiedDomains = (senderConfig.domains ?? [])
    .filter((d) => d.status === "verified")
    .map((d) => d.domain);

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      <Section title="Basics" description="The waitlist name and what each signup must provide.">
        <TextField
          label="Waitlist name"
          value={form.waitlistName}
          onChange={(v) => set("waitlistName", v)}
          required
        />
        <ReadOnlyField
          label="Page slug (locked)"
          value={`/waitlist/${campaignId}`}
          hint="Set when the launch was created and can't be changed — this is your default YouGrow.ai page."
        />
        <TextField
          label="Waitlist URL"
          value={form.waitlistUrlLocation ?? ""}
          onChange={(v) => set("waitlistUrlLocation", v)}
          placeholder="https://yourbrand.com/early-access (optional)"
          hint="Where your waitlist lives. Leave blank to use your YouGrow.ai page above. If you've embedded the widget on your own site, paste that page's full URL so referral links point to your domain."
        />
        <SelectField
          label="Required contact detail"
          value={form.requiredContactDetail}
          onChange={(v) => set("requiredContactDetail", v as CampaignSettings["requiredContactDetail"])}
          options={CONTACT_OPTIONS}
        />
        <Toggle
          label="Collect first & last name"
          checked={form.usesFirstnameLastname}
          onChange={(v) => set("usesFirstnameLastname", v)}
        />
        <Toggle
          label="Require email verification (double opt-in)"
          checked={form.usesSignupVerification}
          onChange={(v) => set("usesSignupVerification", v)}
        />
      </Section>

      <Section
        title="Strategy & Context"
        description="The core objectives and brand-voice constraints your agents use."
      >
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[16rem] flex-1">
            <SelectField
              label="Campaign goal"
              value={form.strategy.campaignGoal}
              onChange={(v) => setStrategy("campaignGoal", v)}
              options={CAMPAIGN_GOAL_OPTIONS}
            />
          </div>
          <NumberField
            label="Target count"
            value={form.strategy.targetCount}
            onChange={(v) => setStrategy("targetCount", v)}
            min={0}
          />
        </div>
        <SelectField
          label="Target audience / CRM filter"
          value={form.strategy.targetAudience}
          onChange={(v) => setStrategy("targetAudience", v)}
          options={TARGET_AUDIENCE_OPTIONS}
        />
        <SelectField
          label="Brand tone & voice"
          value={form.strategy.brandTone}
          onChange={(v) => setStrategy("brandTone", v)}
          options={BRAND_TONE_OPTIONS}
        />
        <TextAreaField
          label="Custom instructions"
          value={form.strategy.customToneInstructions ?? ""}
          onChange={(v) => setStrategy("customToneInstructions", v)}
          placeholder="Avoid corporate fluff. Speak like a peer. Focus on speed and APIs."
        />
      </Section>

      <Section
        title="AI Conversation"
        description="An optional post-signup voice chat (Gemini Live) that asks new signups why they joined — and boosts their queue position when they finish."
      >
        <Toggle
          label="Enable post-signup AI voice conversation"
          checked={form.aiConversation.enabled}
          onChange={(v) => setAiConversation("enabled", v)}
        />
        {form.aiConversation.enabled ? (
          <>
            <TextField
              label="Call-to-action line"
              value={form.aiConversation.introLine ?? ""}
              onChange={(v) => setAiConversation("introLine", v)}
              placeholder="Boost your spot — chat with us for 60 seconds about why you joined."
            />
            <TextAreaField
              label="Conversation goal"
              value={form.aiConversation.conversationGoal ?? ""}
              onChange={(v) => setAiConversation("conversationGoal", v)}
              placeholder="Understand the problem they're hoping this solves and how they'd use it."
            />
            <div className="space-y-1">
              <label className="block text-sm font-medium">Topics to probe (one per line)</label>
              <textarea
                value={probeTopicsText}
                onChange={(e) => setProbeTopicsAndDirty(e.target.value)}
                rows={4}
                placeholder={"What problem are you trying to solve?\nWhat do you use today?\nWhat would make this a must-have?"}
                className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              <p className="text-xs text-neutral-500">Up to 10. The AI covers them gently, one at a time.</p>
            </div>
            <NumberField
              label="Leaderboard boost on completion"
              value={form.aiConversation.leaderboardBonus}
              onChange={(v) => setAiConversation("leaderboardBonus", v)}
              min={0}
              max={1000}
            />
            <p className="text-xs text-neutral-500">
              Referral-equivalent boost to the user&apos;s queue position when they finish the chat. 0 = no boost.
            </p>
          </>
        ) : null}
      </Section>

      <Section title="Gamification" description="Referral rewards and the leaderboard.">
        <NumberField
          label="Spots skipped per referral"
          value={form.spotsToMoveUponReferral}
          onChange={(v) => set("spotsToMoveUponReferral", v)}
          min={0}
          max={1000}
        />
        <Toggle
          label="Show the referral leaderboard"
          checked={form.usesLeaderboard}
          onChange={(v) => set("usesLeaderboard", v)}
        />
        <NumberField
          label="Leaderboard length"
          value={form.leaderboardLength}
          onChange={(v) => set("leaderboardLength", v)}
          min={0}
          max={1000}
        />
        <Toggle
          label="Hide signup counts on the page"
          checked={form.hideCounts}
          onChange={(v) => set("hideCounts", v)}
        />
      </Section>

      <Section
        title="Communication"
        description="Who launch emails come from, and referral notifications."
      >
        <SenderDefaultNote senderConfig={senderConfig} />
        <TextField
          label="From name"
          value={form.emailFromName ?? ""}
          onChange={(v) => set("emailFromName", v)}
          placeholder={senderConfig.senderName || "Your brand"}
          hint="Display name shown on launch emails. Blank = account default."
        />
        <SenderAddressField
          verifiedDomains={verifiedDomains}
          value={form.emailFromAddress ?? ""}
          onChange={(v) => set("emailFromAddress", v)}
        />
        <TextField
          label="Reply-to"
          value={form.emailReplyTo ?? ""}
          onChange={(v) => set("emailReplyTo", v)}
          placeholder={senderConfig.replyTo || "replies@yourbrand.com"}
          hint="Where replies go. Blank = account default."
        />
        <Toggle
          label="Email congratulations on each referral"
          checked={form.sendEmailCongratulationsOnReferral}
          onChange={(v) => set("sendEmailCongratulationsOnReferral", v)}
        />

        <div className="space-y-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
          <Toggle
            label="Send an offboarding email when a signup is offboarded"
            checked={form.offboardingEmail.enabled}
            onChange={(v) => setOffboardingEmail("enabled", v)}
          />
          {form.offboardingEmail.enabled ? (
            <>
              <TextField
                label="Subject"
                value={form.offboardingEmail.subject ?? ""}
                onChange={(v) => setOffboardingEmail("subject", v)}
                placeholder="You're off the waitlist for {{waitlist_name}} 🎉"
                hint="Blank = default copy."
              />
              <TextAreaField
                label="Body"
                value={form.offboardingEmail.body ?? ""}
                onChange={(v) => setOffboardingEmail("body", v)}
                placeholder={"Hi {{first_name}},\n\nGreat news — you're off the waitlist…"}
              />
              <p className="text-xs text-neutral-500">
                Tokens: {"{{first_name}}"}, {"{{last_name}}"}, {"{{waitlist_name}}"},{" "}
                {"{{referral_link}}"}. Plain text only.
              </p>
            </>
          ) : null}
        </div>
      </Section>

      <Section title="Questions" description="Survey questions shown on the signup form.">
        <div className="space-y-4">
          {questions.length === 0 ? (
            <p className="text-sm text-neutral-500">No questions yet.</p>
          ) : null}
          {questions.map((q, i) => (
            <div
              key={q.id}
              className="space-y-3 rounded-md border border-neutral-200 p-4 dark:border-neutral-800"
            >
              <div className="flex items-start gap-3">
                <input
                  value={q.question_value}
                  onChange={(e) => updateQuestion(i, { question_value: e.target.value })}
                  placeholder="Question text"
                  className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
                <button
                  type="button"
                  onClick={() => setQuestionsAndDirty(questions.filter((_, idx) => idx !== i))}
                  className="rounded-md border border-red-300 px-2.5 py-2 text-xs text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400"
                >
                  Remove
                </button>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <Toggle
                  label="Optional"
                  checked={q.optional}
                  onChange={(v) => updateQuestion(i, { optional: v })}
                  inline
                />
                <Toggle
                  label="Multiple choice"
                  checked={q.isChoice}
                  onChange={(v) => updateQuestion(i, { isChoice: v })}
                  inline
                />
              </div>
              {q.isChoice ? (
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-neutral-500">
                    Options (one per line)
                  </label>
                  <textarea
                    value={q.optionsText}
                    onChange={(e) => updateQuestion(i, { optionsText: e.target.value })}
                    rows={3}
                    placeholder={"Option A\nOption B"}
                    className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                  />
                </div>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setQuestionsAndDirty([
                ...questions,
                { id: uid(), question_value: "", optional: true, isChoice: false, optionsText: "" },
              ])
            }
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            + Add question
          </button>
        </div>
      </Section>

      {errors.length > 0 ? (
        <ul className="space-y-1 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : null}

      <div className="sticky bottom-0 flex items-center gap-4 border-t border-neutral-200 bg-white/80 py-4 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
        <button
          type="submit"
          disabled={status === "saving" || !dirty}
          className="rounded-md bg-neutral-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {status === "saving" ? "Saving…" : "Save changes"}
        </button>
        {status === "saved" && !dirty ? (
          <span className="text-sm text-green-600 dark:text-green-400">Saved.</span>
        ) : dirty ? (
          <span className="text-sm text-neutral-500">Unsaved changes.</span>
        ) : null}
      </div>
    </form>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-4 md:grid-cols-[14rem_1fr]">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="mt-1 text-sm text-neutral-500">{description}</p> : null}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  required,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium">{label}</label>
      <input
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
      {hint ? <p className="text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

/** Display-only field — used for immutable values like the locked page slug. */
function ReadOnlyField({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium">{label}</label>
      <input
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full cursor-default rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/50 dark:text-neutral-400"
      />
      {hint ? <p className="text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium">{label}</label>
      <textarea
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  // Hold the raw text so the field can be transiently empty while editing
  // (clear-and-retype) instead of snapping to 0. Coerce to a number on change.
  const [text, setText] = useState(String(value));
  const [seenValue, setSeenValue] = useState(value);
  if (value !== seenValue) {
    // External value changed (e.g. reset after save) — resync unless an
    // in-progress edit already parses to the same number.
    setSeenValue(value);
    if (Number(text) !== value) setText(String(value));
  }
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium">{label}</label>
      <input
        type="number"
        value={text}
        min={min}
        max={max}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (raw === "") {
            onChange(0);
            return;
          }
          const n = Math.trunc(Number(raw));
          if (Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => setText(String(value))}
        className="w-32 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
    </div>
  );
}

function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Read-only summary of the tenant default sender (Account Settings → Domains). */
function SenderDefaultNote({ senderConfig }: { senderConfig: EmailSenderConfig }) {
  const tenantFrom =
    senderConfig.fromLocalPart && senderConfig.fromDomain
      ? `${senderConfig.fromLocalPart}@${senderConfig.fromDomain}`
      : null;
  const hasDefault = Boolean(senderConfig.senderName || tenantFrom || senderConfig.replyTo);
  return (
    <p className="text-xs text-neutral-500">
      {hasDefault ? (
        <>
          Inherits{" "}
          {senderConfig.senderName ? <>“{senderConfig.senderName}” </> : null}
          {tenantFrom ? <>&lt;{tenantFrom}&gt; </> : null}
          {senderConfig.replyTo ? <>· reply-to {senderConfig.replyTo} </> : null}
          from your account default. Override per launch below.{" "}
        </>
      ) : (
        <>No account default sender set yet. </>
      )}
      <a href="/admin/account" className="underline">
        Manage in Account Settings
      </a>
      .
    </p>
  );
}

/**
 * Per-launch From-address override: a local-part input plus a verified-domain
 * selector (a dropdown only when more than one domain is verified). A custom
 * From address is only honoured when its domain is verified, so we constrain the
 * choice to verified domains; with none, the override is disabled. Blank local
 * part → empty string → inherit the account default.
 */
function SenderAddressField({
  verifiedDomains,
  value,
  onChange,
}: {
  verifiedDomains: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const at = value.lastIndexOf("@");
  const local = at >= 0 ? value.slice(0, at) : value;
  const domain = at >= 0 ? value.slice(at + 1) : (verifiedDomains[0] ?? "");
  const compose = (l: string, d: string) => onChange(l.trim() && d ? `${l.trim()}@${d}` : "");

  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium">From address</label>
      {verifiedDomains.length === 0 ? (
        <p className="text-sm text-neutral-500">
          Add &amp; verify a sending domain in{" "}
          <a href="/admin/account" className="underline">
            Account Settings
          </a>{" "}
          to send from your own address.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <input
              value={local}
              onChange={(e) => compose(e.target.value, domain)}
              placeholder="hello"
              aria-label="From address local part"
              className="w-40 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <span className="text-sm text-neutral-500">@</span>
            {verifiedDomains.length === 1 ? (
              <span className="text-sm">{verifiedDomains[0]}</span>
            ) : (
              <select
                value={domain}
                onChange={(e) => compose(local, e.target.value)}
                aria-label="From address domain"
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              >
                {verifiedDomains.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            )}
          </div>
          <p className="text-xs text-neutral-500">Blank = account default.</p>
        </>
      )}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  inline,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  inline?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2 ${inline ? "" : "py-0.5"} text-sm`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-neutral-300"
      />
      <span>{label}</span>
    </label>
  );
}
