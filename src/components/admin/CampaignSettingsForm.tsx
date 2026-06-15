"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CampaignSettings } from "@/lib/admin/campaignSettings";
import type { ConfigurationStyle } from "@/lib/types/campaign";

const CONTACT_OPTIONS: { value: CampaignSettings["requiredContactDetail"]; label: string }[] = [
  { value: "EMAIL", label: "Email only" },
  { value: "PHONE", label: "Phone only" },
  { value: "BOTH", label: "Email and phone" },
  { value: "EITHER", label: "Email or phone" },
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

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

interface LinkRow {
  id: string;
  key: string;
  value: string;
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

function toLinkRows(settings: CampaignSettings): LinkRow[] {
  return Object.entries(settings.configurationStyleJson.socialLinks ?? {}).map(
    ([key, value]) => ({ id: uid(), key, value }),
  );
}

export function CampaignSettingsForm({
  campaignId,
  initial,
}: {
  campaignId: string;
  initial: CampaignSettings;
}) {
  const router = useRouter();
  const [form, setForm] = useState<CampaignSettings>(initial);
  const [questions, setQuestions] = useState<UiQuestion[]>(() => toUiQuestions(initial));
  const [socialLinks, setSocialLinks] = useState<LinkRow[]>(() => toLinkRows(initial));
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errors, setErrors] = useState<string[]>([]);

  function set<K extends keyof CampaignSettings>(key: K, value: CampaignSettings[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
    setStatus("idle");
  }
  function setStyle<K extends keyof ConfigurationStyle>(key: K, value: ConfigurationStyle[K]) {
    setForm((f) => ({
      ...f,
      configurationStyleJson: { ...f.configurationStyleJson, [key]: value },
    }));
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
  function setLinksAndDirty(next: LinkRow[]) {
    setSocialLinks(next);
    setDirty(true);
    setStatus("idle");
  }

  /**
   * Client-side checks for lossy/ambiguous input the server can't detect after
   * the fact (the socialLinks Record has already collapsed duplicates/blanks by
   * the time it serialises). Returns human-readable errors; empty = ok.
   */
  function validate(): string[] {
    const errs: string[] = [];
    const colorFields: [keyof ConfigurationStyle, string][] = [
      ["widgetBackgroundColor", "Background colour"],
      ["widgetButtonColor", "Button colour"],
      ["widgetFontColor", "Font colour"],
    ];
    for (const [k, label] of colorFields) {
      const v = form.configurationStyleJson[k];
      if (typeof v === "string" && v.trim() && !HEX_RE.test(v.trim())) {
        errs.push(`${label} must be a 6-digit hex value like #4937E7.`);
      }
    }
    const seen = new Set<string>();
    socialLinks.forEach((l, i) => {
      const key = l.key.trim();
      if (!key && l.value.trim()) {
        errs.push(`Social link #${i + 1} has a URL but no label.`);
      }
      if (key) {
        if (seen.has(key)) errs.push(`Duplicate social link label: "${key}".`);
        seen.add(key);
      }
    });
    return errs;
  }

  /** Build the wire payload. The server schema re-validates and normalises. */
  function buildPayload(): CampaignSettings {
    const style: ConfigurationStyle = { ...form.configurationStyleJson };
    // Drop empty branding strings so we don't persist blank colours.
    for (const key of ["widgetBackgroundColor", "widgetButtonColor", "widgetFontColor", "statusDescription"] as const) {
      if (!style[key]) delete style[key];
    }
    // Rebuild social links from the editor; drop rows with a blank label.
    const links: Record<string, string> = {};
    for (const { key, value } of socialLinks) {
      const k = key.trim();
      if (k) links[k] = value.trim();
    }
    if (Object.keys(links).length > 0) style.socialLinks = links;
    else delete style.socialLinks;
    return {
      ...form,
      waitlistName: form.waitlistName.trim(),
      waitlistUrlLocation: form.waitlistUrlLocation?.trim() ? form.waitlistUrlLocation.trim() : null,
      // Send an explicit "" (never undefined) so clearing the message actually
      // overwrites the stored value — Firestore update() is a merge and would
      // otherwise keep the old copy.
      twitterMessage: form.twitterMessage?.trim() ?? "",
      configurationStyleJson: style,
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
        setSocialLinks(toLinkRows(settings));
      }
      setDirty(false);
      setStatus("saved");
      router.refresh();
    } catch {
      setErrors(["Network error — please try again."]);
      setStatus("error");
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      <Section title="Basics" description="The waitlist name and what each signup must provide.">
        <TextField
          label="Waitlist name"
          value={form.waitlistName}
          onChange={(v) => set("waitlistName", v)}
          required
        />
        <TextField
          label="URL slug"
          value={form.waitlistUrlLocation ?? ""}
          onChange={(v) => set("waitlistUrlLocation", v)}
          placeholder="e.g. beta-launch (optional)"
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

      <Section title="Branding" description="Colours and copy for the hosted widget.">
        <ColorField
          label="Background colour"
          value={form.configurationStyleJson.widgetBackgroundColor ?? ""}
          onChange={(v) => setStyle("widgetBackgroundColor", v)}
        />
        <ColorField
          label="Button colour"
          value={form.configurationStyleJson.widgetButtonColor ?? ""}
          onChange={(v) => setStyle("widgetButtonColor", v)}
        />
        <ColorField
          label="Font colour"
          value={form.configurationStyleJson.widgetFontColor ?? ""}
          onChange={(v) => setStyle("widgetFontColor", v)}
        />
        <TextField
          label="Success message"
          value={form.configurationStyleJson.statusDescription ?? ""}
          onChange={(v) => setStyle("statusDescription", v)}
          placeholder="You're on the list!"
        />
        <div className="space-y-2">
          <label className="block text-sm font-medium">Social links</label>
          {socialLinks.length === 0 ? (
            <p className="text-sm text-neutral-500">No social links.</p>
          ) : null}
          {socialLinks.map((l, i) => (
            <div key={l.id} className="flex items-center gap-2">
              <input
                value={l.key}
                onChange={(e) =>
                  setLinksAndDirty(socialLinks.map((s, idx) => (idx === i ? { ...s, key: e.target.value } : s)))
                }
                placeholder="Label (e.g. twitter)"
                aria-label="Social link label"
                className="w-40 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              <input
                value={l.value}
                onChange={(e) =>
                  setLinksAndDirty(socialLinks.map((s, idx) => (idx === i ? { ...s, value: e.target.value } : s)))
                }
                placeholder="https://…"
                aria-label="Social link URL"
                className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              <button
                type="button"
                onClick={() => setLinksAndDirty(socialLinks.filter((_, idx) => idx !== i))}
                className="rounded-md border border-red-300 px-2.5 py-2 text-xs text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setLinksAndDirty([...socialLinks, { id: uid(), key: "", value: "" }])}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            + Add link
          </button>
        </div>
        <Toggle
          label="Remove widget headers"
          checked={form.removeWidgetHeaders}
          onChange={(v) => set("removeWidgetHeaders", v)}
        />
      </Section>

      <Section title="Marketing" description="Social share copy and referral notifications.">
        <TextField
          label="Twitter / X share message"
          value={form.twitterMessage ?? ""}
          onChange={(v) => set("twitterMessage", v)}
          placeholder="I just joined the waitlist!"
        />
        <Toggle
          label="Email congratulations on each referral"
          checked={form.sendEmailCongratulationsOnReferral}
          onChange={(v) => set("sendEmailCongratulationsOnReferral", v)}
        />
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
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

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={HEX_RE.test(value) ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} swatch`}
          className="h-9 w-12 cursor-pointer rounded border border-neutral-300 bg-transparent dark:border-neutral-700"
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#000000"
          className="w-32 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
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
