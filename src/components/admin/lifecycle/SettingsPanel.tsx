"use client";

import type { LifecycleSettings } from "@/lib/types/lifecycle";
import type { ConnectionCatalog } from "@/lib/types/productConnection";
import { Badge, Field, Section, inputClass } from "../connect/ui";

/**
 * Journey settings: what starts it, when emails may go out (in each person's own
 * timezone), who they come from, and the unsubscribe category. A launch's
 * welcome journey (`waitlist`, engine move) starts when someone joins, can send
 * at any time, has no end date by default, and sends from the launch's sender.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RESERVED = ["user.signed_up", "onboarding.completed"];
/** Derived by YouGrow from the consent a product sends (LIFECYCLE_CONSENT_AT_SEND). */
const CONSENT_GRANTED = "user.marketing_consent_granted";

export function SettingsPanel({
  settings,
  catalog,
  sender,
  readOnly,
  onChange,
  waitlist = null,
  consentAtSend = false,
}: {
  settings: LifecycleSettings;
  catalog: ConnectionCatalog | undefined;
  sender: { verified: boolean; fromEmail: string | null; fromName?: string | null };
  readOnly: boolean;
  onChange: (next: LifecycleSettings) => void;
  waitlist?: { launchId: string; launchName: string } | null;
  /** Consent decides marketing: the consent-only setting and the opt-in trigger. */
  consentAtSend?: boolean;
}) {
  const p = settings.sendPolicy;
  const setPolicy = (patch: Partial<LifecycleSettings["sendPolicy"]>) => onChange({ ...settings, sendPolicy: { ...p, ...patch } });
  const events = [...new Set([...RESERVED, ...(consentAtSend ? [CONSENT_GRANTED] : []), ...(catalog?.events ?? []).map((e) => e.name)])];
  const entry = settings.entry ?? { requireMarketingConsent: false };
  const time = `${String(p.startHour).padStart(2, "0")}:${String(p.startMinute).padStart(2, "0")}`;
  const endMin = p.startHour * 60 + p.startMinute + p.windowMinutes;
  const tooLate = endMin > 24 * 60;

  if (waitlist) {
    return (
      <div className="space-y-4">
        <Section title="Starts when" description="Someone joins the waitlist and verifies their email. Each person enters once.">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Everyone on {waitlist.launchName}&rsquo;s list who joins while this journey is live gets it — and anyone who joins while it&rsquo;s paused starts when you resume it.
          </p>
        </Section>
        <Section title="When emails go out" description="Welcome emails have always gone out as soon as each step is due.">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={readOnly} checked={Boolean(p.anytime)} onChange={(e) => setPolicy({ anytime: e.target.checked || undefined })} />
            Any time of day, any day
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={p.hardStopDays !== null}
              onChange={(e) => setPolicy({ hardStopDays: e.target.checked ? 60 : null })}
            />
            Stop after
            <input
              className={`${inputClass} w-20`}
              type="number"
              min={1}
              max={60}
              disabled={readOnly || p.hardStopDays === null}
              value={p.hardStopDays ?? ""}
              onChange={(e) => setPolicy({ hardStopDays: Math.min(60, Math.max(1, Number(e.target.value) || 1)) })}
            />
            days
          </label>
        </Section>
        <Section title="Sender" description="Welcome emails come from the launch's sender, set in the launch's settings (or your Domains settings).">
          <p className="text-sm">
            {sender.fromName ?? "Your brand"} {sender.fromEmail ? <span className="text-neutral-500">&lt;{sender.fromEmail}&gt;</span> : <span className="text-neutral-500">(the default address)</span>}
          </p>
        </Section>
        <Section title="Tracking" description="On for welcome emails, as it has always been, so opens and clicks show in the launch's analytics.">
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" disabled={readOnly} checked={settings.tracking.opens} onChange={(e) => onChange({ ...settings, tracking: { ...settings.tracking, opens: e.target.checked } })} />
              Track opens
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" disabled={readOnly} checked={settings.tracking.clicks} onChange={(e) => onChange({ ...settings, tracking: { ...settings.tracking, clicks: e.target.checked } })} />
              Track clicks
            </label>
          </div>
        </Section>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Section title="Starts when" description="Which product event enrols someone. Each person enters once.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Event">
            <select
              className={inputClass}
              value={settings.trigger.event}
              disabled={readOnly}
              onChange={(e) => onChange({ ...settings, trigger: { ...settings.trigger, event: e.target.value } })}
            >
              {events.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ignore events older than (hours)" hint="So a backfill of old sign-ups doesn't start the sequence.">
            <input
              className={inputClass}
              type="number"
              min={1}
              max={720}
              disabled={readOnly}
              value={settings.trigger.maxEventAgeHours}
              onChange={(e) => onChange({ ...settings, trigger: { ...settings.trigger, maxEventAgeHours: Math.min(720, Math.max(1, Number(e.target.value) || 1)) } })}
            />
          </Field>
        </div>
        {consentAtSend ? (
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              disabled={readOnly}
              checked={entry.requireMarketingConsent}
              onChange={(e) => onChange({ ...settings, entry: { ...entry, requireMarketingConsent: e.target.checked } })}
            />
            <span>
              Only people with marketing consent
              <span className="block text-xs text-neutral-500">
                Uses the consent your product sends. Someone who opts in while the event is still recent enough joins then, from the start.
              </span>
            </span>
          </label>
        ) : null}
      </Section>

      <Section title="Send window" description="Emails only go out in this window, in each person's own timezone, at a steady minute that's theirs. Nothing is ever sent late.">
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((d, i) => (
            <label key={d} className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-sm dark:border-neutral-800">
              <input
                type="checkbox"
                disabled={readOnly}
                checked={p.days.includes(i)}
                onChange={(e) => {
                  const days = e.target.checked ? [...p.days, i].sort() : p.days.filter((x) => x !== i);
                  if (days.length) setPolicy({ days });
                }}
              />
              {d}
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="From">
            <input
              className={inputClass}
              type="time"
              disabled={readOnly}
              value={time}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                if (Number.isFinite(h) && Number.isFinite(m)) setPolicy({ startHour: h!, startMinute: m! });
              }}
            />
          </Field>
          <Field label="Window (minutes)">
            <input className={inputClass} type="number" min={15} max={720} disabled={readOnly} value={p.windowMinutes} onChange={(e) => setPolicy({ windowMinutes: Math.min(720, Math.max(15, Number(e.target.value) || 15)) })} />
          </Field>
          <Field label="Stop after (days)">
            <input className={inputClass} type="number" min={1} max={60} disabled={readOnly} value={p.hardStopDays ?? ""} onChange={(e) => setPolicy({ hardStopDays: Math.min(60, Math.max(1, Number(e.target.value) || 1)) })} />
          </Field>
          <Field label="Timezone if unknown">
            <input className={inputClass} disabled={readOnly} value={p.fallbackTimezone} onChange={(e) => setPolicy({ fallbackTimezone: e.target.value.slice(0, 64) })} />
          </Field>
        </div>
        {tooLate ? <p className="text-sm text-red-600">The window must end by midnight.</p> : null}
      </Section>

      <Section
        title="Sender"
        description={
          <>
            Blank fields use your Domains settings. Live sending needs the From address on a verified sending domain{" "}
            {sender.verified ? <Badge tone="green">verified: {sender.fromEmail}</Badge> : <Badge tone="amber">not verified</Badge>}
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="From name">
            <input className={inputClass} disabled={readOnly} value={settings.sender.fromName ?? ""} placeholder="Jez at Vizzybl" onChange={(e) => onChange({ ...settings, sender: { ...settings.sender, fromName: e.target.value || null } })} />
          </Field>
          <Field label="From address">
            <input className={inputClass} type="email" disabled={readOnly} value={settings.sender.fromEmail ?? ""} placeholder="jez@vizzybl.ai" onChange={(e) => onChange({ ...settings, sender: { ...settings.sender, fromEmail: e.target.value.trim() || null } })} />
          </Field>
          <Field label="Reply-to">
            <input className={inputClass} type="email" disabled={readOnly} value={settings.sender.replyTo ?? ""} onChange={(e) => onChange({ ...settings, sender: { ...settings.sender, replyTo: e.target.value.trim() || null } })} />
          </Field>
        </div>
      </Section>

      <Section title="Unsubscribe category" description="One-click unsubscribe stops this category only (the product is told, so it can mirror it). People can still opt out of everything.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name people see">
            <input className={inputClass} disabled={readOnly} value={settings.category.label} onChange={(e) => onChange({ ...settings, category: { ...settings.category, label: e.target.value.slice(0, 80) } })} />
          </Field>
          <Field label="Key sent to the product">
            <input
              className={`${inputClass} font-mono`}
              disabled={readOnly}
              value={settings.category.key}
              onChange={(e) => onChange({ ...settings, category: { ...settings.category, key: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64) } })}
            />
          </Field>
        </div>
      </Section>

      <Section title="Tracking" description="Off by default: open and click tracking rewrites links and adds a pixel, which can hurt deliverability for personal-style emails.">
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={readOnly} checked={settings.tracking.opens} onChange={(e) => onChange({ ...settings, tracking: { ...settings.tracking, opens: e.target.checked } })} />
            Track opens
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={readOnly} checked={settings.tracking.clicks} onChange={(e) => onChange({ ...settings, tracking: { ...settings.tracking, clicks: e.target.checked } })} />
            Track clicks
          </label>
        </div>
      </Section>
    </div>
  );
}
