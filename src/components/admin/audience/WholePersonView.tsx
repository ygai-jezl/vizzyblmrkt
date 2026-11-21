"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Sparkles, Trash2 } from "lucide-react";
import type { WholePerson } from "@/lib/audience/wholePerson";
import { CONSENT_WAYS, NEW_PERSON_MESSAGES, NEW_PERSON_NOTES, newPersonErrorText, type ConsentWay } from "@/lib/audience/newPerson";
import { INVITE_STAGE_LABEL } from "@/lib/invites/inviteStage";
import { api, errorText } from "../connect/api";
import { Banner, Button, inputClass, Section } from "../connect/ui";
import { Chip } from "../people/Chip";
import { PersonView } from "../people/PersonView";
import { EmailHistoryList } from "../crm/EmailHistoryList";
import { useShell } from "../nav/ShellProvider";
import { ago, day } from "../people/format";
import { FieldsPanel } from "./FieldsPanel";
import { PersonTimeline } from "./PersonTimeline";

/**
 * One person, whole (AUDIENCE_ONE_VIEW_ENABLED): everything a brand knows about one
 * address, whatever brought them. Their launches, each product they use (shown as that
 * product's own view of them), the emails their launches sent, and one consent panel.
 */

const LAUNCH_STATUS: Record<string, string> = { verified_active: "Confirmed", unverified: "Not confirmed yet", offboarded: "Offboarded" };
const JOURNEY_STATUS = { active: "In progress", completed: "Finished", exited: "Stopped" } as const;
const STAGE = { new: "New", onboarding: "Onboarding", stuck: "Stuck", activated: "Activated", member: "Using the product" } as const;
const BLOCKED: Record<string, string> = {
  unsubscribe: "They unsubscribed, so no marketing email goes to this address.",
  spam: "They marked an email as spam, so nothing more goes to this address.",
  hard_bounce: "Their address bounced, so nothing more goes to it.",
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

type State = { status: "loading" } | { status: "ok"; person: WholePerson } | { status: "gone" } | { status: "error" };

export function WholePersonView({
  personId,
  canEdit,
  vizzy = false,
  productView = false,
  fields = false,
  fieldFilters = false,
  addPerson = false,
  timeline = false,
}: {
  personId: string;
  canEdit: boolean;
  /** Vizzy can read this person's situation (LIFECYCLE_PERSON_BRIEF). */
  vizzy?: boolean;
  /** Each product user's own view is on (AUDIENCE_PERSON_VIEW): show it for each product. */
  productView?: boolean;
  /** Fields are on (AUDIENCE_FIELDS_ENABLED): the Fields panel, with fields from elsewhere and voice chats. */
  fields?: boolean;
  /** Field filters are on (AUDIENCE_FIELD_FILTERS_ENABLED): each product group links to everyone in it. */
  fieldFilters?: boolean;
  /** New person is on (AUDIENCE_ADD_PERSON_ENABLED): an admin can record how someone added by hand agreed. */
  addPerson?: boolean;
  /** The timeline is on (AUDIENCE_TIMELINE_ENABLED): it sits beside the rest, above consent. */
  timeline?: boolean;
}) {
  const shell = useShell();
  const [state, setState] = useState<State>({ status: "loading" });
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [erasing, setErasing] = useState<"no" | "busy" | "queued">("no");

  const load = useCallback(async () => {
    const r = await api<{ person: WholePerson }>(`/api/admin/audience/everyone/${encodeURIComponent(personId)}`);
    if (r.ok) setState({ status: "ok", person: r.data.person });
    else setState({ status: r.status === 404 ? "gone" : "error" });
  }, [personId]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = (
    <Link href="/admin/crm" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
      <ArrowLeft size={14} /> People
    </Link>
  );

  if (state.status === "loading") return <p className="text-sm text-neutral-500">Loading…</p>;
  if (state.status !== "ok") {
    return (
      <div className="space-y-3">
        {back}
        <Banner tone={state.status === "gone" ? "info" : "err"}>
          {state.status === "gone"
            ? "YouGrow doesn't hold this person: the link is old, or they were erased."
            : "Couldn't load this person. Reload the page to try again."}
        </Banner>
      </div>
    );
  }

  const p = state.person;
  const eraseEverywhere = async () => {
    const what = [
      p.launches.length ? "their sign-ups on every launch" : null,
      p.products.length ? "their user record in every product" : null,
      "their journeys and all their email history",
    ].filter(Boolean);
    const ask = `Erase ${p.email ?? p.name ?? "this person"} everywhere? ${what.join(", ").replace(/^./, (c) => c.toUpperCase())} go. Their unsubscribe keeps holding, without their address. This can't be undone.`;
    if (!window.confirm(ask)) return;
    setErasing("busy");
    const r = await api(`/api/admin/crm/contacts/${encodeURIComponent(p.id)}/erase`, { method: "POST" });
    if (!r.ok) {
      setErasing("no");
      return setMsg({ tone: "err", text: errorText(r.data) });
    }
    setErasing("queued");
    setMsg({ tone: "ok", text: "Erasing them everywhere. It finishes within a few minutes; then this page finds nobody." });
  };
  const sources = [
    p.launches.length ? plural(p.launches.length, "sign-up") : null,
    p.products.length ? plural(p.products.length, "product user") : null,
  ].filter(Boolean);
  const reach =
    p.reach === "yes"
      ? { tone: "green" as const, chip: "Can email" }
      : p.reach === "limited"
        ? { tone: "amber" as const, chip: "Some emails only" }
        : { tone: "red" as const, chip: "Can't email" };

  // Their parts, and consent: beside the timeline when it is on, in one column otherwise.
  const main = (
    <>
      {fields && p.fields ? (
        <FieldsPanel object="person" recordId={p.id} initialValues={p.fields.values} readOnly={p.fields.readOnly} voiceChats={p.fields.voiceChats} canEdit={canEdit} />
      ) : null}

      {p.launches.length ? (
        <Section title="Launches">
          <ul className="divide-y divide-neutral-100 text-sm dark:divide-neutral-900">
            {p.launches.map((l) => (
              <li key={l.campaignId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="font-medium">{l.name}</span>
                <Chip tone={l.status === "verified_active" ? "green" : "neutral"}>{LAUNCH_STATUS[l.status] ?? l.status}</Chip>
                <span className="text-xs text-neutral-500">
                  {[
                    `Joined ${day(l.joinedAt)}${l.via === "site" ? " from your site" : ""}`,
                    l.referrals ? plural(l.referrals, "referral") : null,
                    l.invite ? `Invite: ${INVITE_STAGE_LABEL[l.invite]}` : null,
                    l.journey ? `Waitlist journey: ${JOURNEY_STATUS[l.journey.status]}, ${plural(l.journey.sent, "email")} sent` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {p.products.map((x) =>
        productView ? (
          <section key={x.productUserId} className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
            <PersonView personId={x.productUserId} canEdit={canEdit} embedded={{ onErased: () => void load() }} />
          </section>
        ) : (
          <Section key={x.productUserId} title={x.name}>
            <p className="text-sm">
              {STAGE[x.stage]}.{x.quiet ? " Quiet lately." : ""}{" "}
              <Link href={`/admin/products/${x.connectionId}?tab=users`} className="underline underline-offset-2">
                Open in the product
              </Link>
            </p>
          </Section>
        ),
      )}

      {fieldFilters && p.products.some((x) => x.groups?.length) ? (
        <Section title="Product groups">
          <ul className="divide-y divide-neutral-100 text-sm dark:divide-neutral-900">
            {p.products.flatMap((x) =>
              (x.groups ?? []).map((g) => (
                <li key={`${x.connectionId}:${g.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span>
                    <span className="text-neutral-500">In {x.name}:</span>{" "}
                    {g.kind ? `${g.kind.charAt(0).toUpperCase()}${g.kind.slice(1)}: ` : ""}
                    {g.name ?? g.id}
                  </span>
                  <Link href={`/admin/crm?group=${encodeURIComponent(`${x.connectionId}:${g.id}`)}`} className="text-xs underline underline-offset-2">
                    Everyone in this group
                  </Link>
                </li>
              )),
            )}
          </ul>
        </Section>
      ) : null}

      {p.launches.length ? (
        <Section title={`Emails from your launches${p.launchEmails.length ? ` (${p.launchEmails.length})` : ""}`}>
          <EmailHistoryList emails={p.launchEmails} />
        </Section>
      ) : null}
    </>
  );
  const consent = (
    <Section title="Consent, in one place">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-neutral-500">Can email</dt>
        <dd>
          {p.reach === "yes"
            ? "Yes"
            : p.blocked
              ? BLOCKED[p.blocked]
              : p.reach === "limited"
                ? "Some emails only: service emails, a confirmation, or not every kind"
                : "No"}
        </dd>
        {p.launches.map((l) => (
          <FragmentPair key={l.campaignId} label={l.name} value={l.status === "verified_active" ? "Confirmed their sign-up" : LAUNCH_STATUS[l.status] ?? l.status} />
        ))}
        {p.optedOutOf.length ? <FragmentPair label="Opted out of" value={p.optedOutOf.join(", ")} /> : null}
        {p.added ? (
          <FragmentPair
            label="Marketing emails"
            value={
              p.added.consent
                ? `They agreed: ${p.added.consent.howLabel}${p.added.consent.note ? ` (${p.added.consent.note})` : ""}. Recorded by ${p.added.consent.by} on ${day(p.added.consent.at)}.`
                : "Not yet"
            }
          />
        ) : null}
      </dl>
      {p.added ? (
        <>
          {!p.added.consent && canEdit && addPerson ? <RecordConsent personId={p.id} onRecorded={() => void load()} /> : null}
          <p className="text-xs text-neutral-500">{NEW_PERSON_NOTES.nothingSent}</p>
        </>
      ) : null}
      <p className="text-xs text-neutral-500">Unsubscribing from any email stops all of your marketing email to this address. Each product&rsquo;s own consent is in its part above.</p>
    </Section>
  );

  return (
    <div className={`${timeline ? "max-w-6xl" : "max-w-5xl"} space-y-5`}>
      {back}

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <h1 className="text-lg font-semibold">{p.name ?? p.email ?? p.phone ?? "Unnamed person"}</h1>
          <p className="break-words text-sm text-neutral-500">
            {[p.name ? (p.email ?? p.phone) : null, `Known since ${day(p.firstSeenAt)}`, p.activeAt ? `last active ${ago(p.activeAt)}` : null].filter(Boolean).join(" · ")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Chip tone={reach.tone} title={p.blocked ? BLOCKED[p.blocked] : undefined}>
              {reach.chip}
            </Chip>
            {p.launches.map((l) => (
              <Chip key={l.campaignId}>{l.name}</Chip>
            ))}
            {p.products.map((x) => (
              <Chip key={x.productUserId} tone="blue">
                {x.name}
              </Chip>
            ))}
          </div>
          {sources.length ? (
            <p className="text-xs text-neutral-500">
              Built from {sources.join(" and ")}
              {p.email ? " with the same email" : ""}.
            </p>
          ) : null}
          {p.added ? (
            <p className="text-xs text-neutral-500">
              Added by hand by {p.added.by} on {day(p.added.at)}
              {p.added.via === "palette" ? ", from ⌘K" : ""}.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {vizzy && shell ? (
            <Button tone="primary" onClick={() => shell.setVizzyOpen(true)} title="Vizzy sees their situation, never their name or address">
              <Sparkles size={14} /> Ask Vizzy
            </Button>
          ) : null}
          {canEdit ? (
            <>
              <a
                href={`/api/admin/audience/everyone/${encodeURIComponent(p.id)}/export`}
                className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900"
              >
                <Download size={14} /> Export their data
              </a>
              <Button tone="danger" disabled={erasing !== "no"} onClick={() => void eraseEverywhere()}>
                <Trash2 size={14} /> {erasing === "busy" ? "Erasing…" : erasing === "queued" ? "Erasing" : "Erase everywhere"}
              </Button>
            </>
          ) : null}
        </div>
      </header>

      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}

      {timeline ? (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="min-w-0 space-y-5">{main}</div>
          <div className="min-w-0 space-y-5">
            <PersonTimeline personId={p.id} canEdit={canEdit} />
            {consent}
          </div>
        </div>
      ) : (
        <>
          {main}
          {consent}
        </>
      )}
    </div>
  );
}

/** Record how someone added by hand agreed to marketing email, after they were added. Admins only. */
function RecordConsent({ personId, onRecorded }: { personId: string; onRecorded: () => void }) {
  const [open, setOpen] = useState(false);
  const [how, setHow] = useState<ConsentWay>("in_person");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} className="text-xs">
        Record that they agreed
      </Button>
    );
  }
  const save = async () => {
    if (how === "other" && !note.trim()) return setError(NEW_PERSON_MESSAGES.note_needed);
    setBusy(true);
    setError(null);
    const r = await api(`/api/admin/audience/everyone/${encodeURIComponent(personId)}/consent`, {
      method: "PATCH",
      body: JSON.stringify({ how, ...(note.trim() ? { note: note.trim() } : {}) }),
    });
    setBusy(false);
    if (!r.ok) return setError(newPersonErrorText(r.data));
    onRecorded();
  };
  return (
    <fieldset className="space-y-2 rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <legend className="px-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">How did they agree?</legend>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {CONSENT_WAYS.map((w) => (
          <label key={w.how} className="flex items-center gap-1.5">
            <input type="radio" name={`agree-${personId}`} checked={how === w.how} onChange={() => setHow(w.how)} /> {w.label}
          </label>
        ))}
      </div>
      {how === "other" ? (
        <input type="text" aria-label="How they agreed" placeholder="A short note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
      ) : null}
      <p className="text-xs text-neutral-500">{NEW_PERSON_NOTES.agreeHint}</p>
      {error ? <Banner tone="err">{error}</Banner> : null}
      <div className="flex gap-2">
        <Button tone="primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </fieldset>
  );
}

function FragmentPair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  );
}
