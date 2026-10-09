"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, Sparkles, Trash2, UserPlus } from "lucide-react";
import type { PersonEmail } from "@/lib/audience/personEmails";
import type { PersonLookup, PersonRecord } from "@/lib/audience/personRecord";
import { PEOPLE_HREF, personHref } from "@/lib/audience/paths";
import { reachText, stageChips } from "@/lib/audience/personStage";
import type { PersonMoment } from "@/lib/audience/personTimeline";
import { api, errorText } from "../connect/api";
import { Badge, Banner, Button, Section, inputClass } from "../connect/ui";
import { Chip } from "./Chip";
import { JourneyCard } from "./JourneyCard";
import { PlanPanel } from "./PlanPanel";
import { useShell } from "../nav/ShellProvider";
import { ago, day, dayTime, shortUrl, time, wallClock } from "./format";

/**
 * One product user, whole: who they are and where they are in your product, each
 * journey they're in with what comes next, every email and what they did with it,
 * and one story of it all. Everything here is what YouGrow already holds — opening
 * the page asks your product nothing.
 */

type State = { status: "loading" } | { status: "ok"; person: PersonRecord } | { status: "gone"; erasedAt?: string } | { status: "error" };

const RUN_NOW: Record<string, string> = {
  draft_prepared: "Prepared the personalised version of the next email. Review it in Approvals, then run the next step again to send.",
  draft_fallback: "The personalised version couldn't be prepared, so the next email uses the standard wording. Run the next step again to send it.",
  sent: "Sent.",
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The basis a product sent for emailing someone, in words. */
const BASIS: Record<string, string> = { consent: "Consent given", soft_opt_in: "Soft opt-in", corporate_subscriber: "Corporate subscriber", none: "None" };
const basisText = (basis: string) => BASIS[basis] ?? basis.replace(/_/g, " ");

/** Where they stand, in a couple of sentences. */
function summaryOf(p: PersonRecord): string {
  const parts: string[] = [];
  const { sent, opened, clicked, tracked, trackedClicks } = p.emailCounts;
  if (sent === 0) parts.push("No emails sent yet.");
  else if (tracked === 0 && trackedClicks === 0) parts.push(`${plural(sent, "email")} sent. Opens and clicks weren't tracked.`);
  // Clicks alone were tracked: an unclicked email may still have been read.
  else if (tracked === 0) parts.push(`${plural(sent, "email")} sent. Opens weren't tracked; ${clicked} of ${trackedClicks} clicked.`);
  else if (tracked < sent) parts.push(`${plural(sent, "email")} sent. Of the ${tracked} we could track, ${opened} opened and ${clicked} clicked.`);
  else if (sent > 1 && opened === sent && clicked === 0) parts.push("Opens every email and hasn't clicked one.");
  else if (sent > 1 && opened === 0) parts.push(`Hasn't opened any of ${sent} emails.`);
  else parts.push(`${opened} of ${plural(sent, "email")} opened, ${clicked} clicked.`);

  const s = p.stage;
  if (s.kind === "stuck" && s.nextStep && s.daysOnStep !== null) parts.push(`Stuck on ${s.nextStep} for ${plural(s.daysOnStep, "day")}.`);
  else if ((s.kind === "new" || s.kind === "onboarding") && s.nextStep) parts.push(`Their next step is ${s.nextStep}.`);
  else if (s.kind === "activated") parts.push("Finished onboarding.");
  if (s.quietDays !== null) parts.push(`Not active for ${plural(s.quietDays, "day")}.`);

  const next = p.journeys.flatMap((j) => (j.status === "active" ? j.steps.filter((x) => x.kind === "next").map((x) => ({ ...x, journey: j.name })) : [])).sort((a, b) => a.at.localeCompare(b.at))[0];
  // Nothing is promised while a journey is held or about to stop: say that instead.
  const stuck = p.journeys.find((j) => j.status === "active" && (j.waiting?.why || j.then?.atNextRun));
  if (next) parts.push(`Next email: ${next.label}, ${day(next.at, p.timezone)}.`);
  else if (stuck?.then?.atNextRun) parts.push(`${stuck.name} stops the next time the sender looks${stuck.then.why ? `: ${stuck.then.why}` : ""}.`);
  else if (stuck?.waiting?.why) parts.push(`${stuck.name} is held: ${stuck.waiting.why.charAt(0).toLowerCase()}${stuck.waiting.why.slice(1)}.`);
  const reach = reachText(p.reach, p.categoryLabels);
  if (reach.why) parts.push(`${reach.why}.`);
  return parts.join(" ");
}

export function PersonView({
  personId,
  canEdit,
  vizzy = false,
}: {
  personId: string;
  canEdit: boolean;
  /** Vizzy can read this person's situation (LIFECYCLE_PERSON_BRIEF): offer to ask. */
  vizzy?: boolean;
}) {
  const router = useRouter();
  const shell = useShell();
  const [state, setState] = useState<State>({ status: "loading" });
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [joinId, setJoinId] = useState("");

  const load = useCallback(async () => {
    const r = await api<PersonLookup>(`/api/admin/audience/people/${encodeURIComponent(personId)}`);
    if (r.ok && r.data.found) setState({ status: "ok", person: r.data.person });
    else if (r.status === 404) setState({ status: "gone", ...(r.data && "erasedAt" in r.data && r.data.erasedAt ? { erasedAt: r.data.erasedAt } : {}) });
    else setState({ status: "error" });
  }, [personId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Vizzy drafted a plan for this person in the chat: show it.
  const subscribe = shell?.onCanvasSaved ?? null;
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((card) => {
      if (card.kind === "person_plan" && card.url === personHref(personId)) void load();
    });
  }, [subscribe, personId, load]);

  const back = (
    <Link href={PEOPLE_HREF} className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
      <ArrowLeft size={14} /> Product users
    </Link>
  );

  if (state.status === "loading") return <p className="text-sm text-neutral-500">Loading…</p>;
  if (state.status === "error") {
    return (
      <div className="space-y-3">
        {back}
        <Banner tone="err">Couldn&rsquo;t load this person — please try again.</Banner>
      </div>
    );
  }
  if (state.status === "gone") {
    return (
      <div className="space-y-3">
        {back}
        <Banner tone="info">
          {state.erasedAt
            ? `This person was erased ${dayTime(state.erasedAt)}. For 30 days YouGrow keeps only a one-way hash of their ids and when they were erased.`
            : "YouGrow doesn't hold this person: the link is old, or they were erased more than 30 days ago."}
        </Banner>
      </div>
    );
  }

  const p = state.person;
  const act = async (key: string, path: string, init: RequestInit, done: (data: Record<string, unknown>) => string) => {
    setBusy(key);
    setMsg(null);
    const r = await api<Record<string, unknown>>(path, init);
    setBusy(null);
    setMsg(r.ok ? { tone: "ok", text: done(r.data) } : { tone: "err", text: errorText(r.data) });
    await load();
  };
  const erase = async () => {
    if (!window.confirm(`Erase ${p.email ?? p.name ?? "this person"}? Their profile, journey progress and email history are deleted. This can't be undone.`)) return;
    setBusy("erase");
    const r = await api(`/api/admin/connections/${p.connectionId}/users/${p.id}`, { method: "DELETE" });
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    router.push(PEOPLE_HREF);
  };

  const reach = reachText(p.reach, p.categoryLabels);
  const clock = wallClock(p.timezone);
  return (
    <div className="max-w-5xl space-y-5">
      {back}

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <h1 className="text-lg font-semibold">{p.name ?? p.email ?? "Unnamed user"}</h1>
          <p className="break-words text-sm text-neutral-500">
            {p.name && p.email ? `${p.email} · ` : ""}
            <Link href={`/admin/products/${p.connectionId}?tab=users`} className="hover:underline">
              {p.product}
            </Link>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {stageChips(p.stage).map((c) => (
              <Chip key={c.text} tone={c.tone}>
                {c.text}
              </Chip>
            ))}
            <Chip tone={reach.tone} title={reach.why ?? undefined}>
              {reach.chip}
            </Chip>
            {p.sandbox ? <Chip>Sandbox test user</Chip> : null}
            {p.waitlistContactId && p.email ? (
              <Link href={`/admin/crm?q=${encodeURIComponent(p.email)}`}>
                <Chip tone="blue">On your waitlist</Chip>
              </Link>
            ) : null}
          </div>
          <p className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-neutral-500">
            <span>Signed up {day(p.signedUpAt)}</span>
            {p.lastActiveAt ? (
              <span>Last active {ago(p.lastActiveAt)}</span>
            ) : (
              <span title="Your product doesn't say when people were last active. This is the last time it sent us anything about them.">Last update {ago(p.lastSyncAt)}</span>
            )}
            {clock ? (
              <span>
                {p.timezone}, {clock} now
              </span>
            ) : null}
          </p>
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
                href={`/api/admin/audience/people/${encodeURIComponent(p.id)}/export`}
                className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900"
              >
                <Download size={14} /> Export their data
              </a>
              <Button tone="danger" disabled={busy === "erase"} onClick={() => void erase()}>
                <Trash2 size={14} /> {busy === "erase" ? "Erasing…" : "Erase"}
              </Button>
            </>
          ) : null}
        </div>
      </header>

      <p className="max-w-3xl text-base font-medium">{summaryOf(p)}</p>

      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
      {p.approvals > 0 ? (
        <Banner tone="info">
          {plural(p.approvals, "personalised line")} for this person {p.approvals === 1 ? "is" : "are"} waiting in{" "}
          <Link href="/admin/approvals" className="underline underline-offset-2">
            Approvals
          </Link>
          .
        </Banner>
      ) : null}

      <Section title="Journeys" description={p.journeys.length ? undefined : "Not in any journey. A journey in test mode only takes the people on its test list, and a sign-up journey only takes people inside its window."}>
        {p.journeys.map((j, i) => (
          <div key={j.enrolmentId} className={i ? "border-t border-neutral-200 pt-4 dark:border-neutral-800" : ""}>
            <JourneyCard
              journey={j}
              emails={p.emails}
              timeZone={p.timezone}
              canEdit={canEdit}
              busy={busy === j.enrolmentId}
              onRunNow={() => void act(j.enrolmentId, `/api/admin/lifecycle/enrolments/${j.enrolmentId}/run-now`, { method: "POST" }, (d) => RUN_NOW[String(d.outcome)] ?? `Ran: ${String(d.outcome).replace(/_/g, " ")}.`)}
              onStop={() => {
                if (window.confirm(`Take them out of ${j.name}?`)) void act(j.enrolmentId, `/api/admin/lifecycle/enrolments/${j.enrolmentId}/stop`, { method: "POST" }, () => "Stopped.");
              }}
            />
          </div>
        ))}
        {canEdit && p.canJoin.length ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <label className="space-y-1">
              <span className="block text-xs font-medium text-neutral-600 dark:text-neutral-400">Add to a journey</span>
              <select className={`${inputClass} w-64`} value={joinId} onChange={(e) => setJoinId(e.target.value)}>
                <option value="">Choose a journey…</option>
                {p.canJoin.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name}
                    {j.mode === "live" ? "" : ` (${j.mode} mode)`}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={!joinId || busy === "join"}
              onClick={() =>
                void act("join", `/api/admin/lifecycle/journeys/${joinId}/enrolments`, { method: "POST", body: JSON.stringify({ userId: p.externalUserId }) }, () => {
                  setJoinId("");
                  return "Added. The first step runs within two minutes.";
                })
              }
            >
              <UserPlus size={14} /> Add
            </Button>
          </div>
        ) : null}
      </Section>

      <Section
        title={`Emails${p.emails.length ? ` (${p.emails.length})` : ""}`}
        description={p.emails.length ? undefined : "Nothing sent yet."}
      >
        {p.emails.length ? <EmailList emails={p.emails} /> : null}
      </Section>

      {p.plan ? (
        <Section
          title="Their plan"
          description="What to help them do next, and how to put it. An approved plan shapes their personalised line, which still goes through Approvals. A plan sends nothing by itself."
        >
          <PlanPanel
            personId={p.id}
            plan={p.plan}
            cannotEmail={p.reach.can === "no" ? reach.why : null}
            canEdit={canEdit}
            onAskVizzy={vizzy && shell ? () => shell.ask("Draft a plan for this person") : null}
            onChanged={load}
          />
        </Section>
      ) : null}

      <Section title="In the product">
        <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
          <div className="space-y-2">
            {p.steps.length ? (
              <>
                {p.stepsAbout ? <p className="text-xs text-neutral-500">Counting {p.stepsAbout}</p> : null}
                <ul className="max-w-md space-y-1.5 text-sm">
                  {p.steps.map((s) => {
                    const next = !s.done && s.label === p.stage.nextStep;
                    return (
                      <li key={s.id} className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 ${s.done ? "border-green-600 bg-green-600" : next ? "border-sky-600 ring-2 ring-sky-100 dark:ring-sky-950" : "border-neutral-400"}`}
                        />
                        <span className={`min-w-0 flex-1 ${next ? "font-medium" : ""}`}>{s.label}</span>
                        <span className="whitespace-nowrap text-xs text-neutral-500">{s.done ? (s.doneAt ? day(s.doneAt) : "done") : next ? "next" : ""}</span>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p className="text-sm text-neutral-500">This product&rsquo;s catalog has no onboarding steps.</p>
            )}
          </div>
          <div className="space-y-3">
            {p.facts.length + p.traits.length === 0 ? (
              <p className="text-sm text-neutral-500">Your product hasn&rsquo;t sent any facts about them.</p>
            ) : (
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                {p.facts.map((f) => (
                  <Pair key={`f:${f.id}`} label={f.label} value={f.value} />
                ))}
                {p.traits.map((t) => (
                  <Pair key={`t:${t.label}`} label={t.label} value={t.value} />
                ))}
              </dl>
            )}
          </div>
        </div>
        {p.entities.length ? (
          <ul className="space-y-1.5 border-t border-neutral-200 pt-3 text-sm dark:border-neutral-800">
            {p.entities.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium">{e.name ?? e.id}</span>
                <span className="text-neutral-500">{e.kind}</span>
                {e.role && e.role !== "owner" ? <Badge>{e.role}</Badge> : null}
                {e.total > 0 ? (
                  <Badge tone={e.done === e.total ? "green" : "neutral"}>
                    {e.done} of {e.total} steps
                  </Badge>
                ) : null}
                {e.facts.length ? <span className="text-xs text-neutral-500">{e.facts.map((f) => `${f.label}: ${f.value}`).join(" · ")}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title="Their story" description={p.timeline.length ? undefined : "Nothing yet."}>
        {p.timeline.length ? <Story moments={p.timeline} /> : null}
        {p.storyCut ? <p className="text-xs text-neutral-500">There is more than fits here: this isn&rsquo;t everything they have done in your product.</p> : null}
      </Section>

      <Section title="Consent and opt-outs">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <Pair
            label="Consent"
            value={
              p.consent.basis
                ? `${basisText(p.consent.basis)}${p.consent.asserted && p.consent.asserted !== p.consent.basis ? ` (your product said ${basisText(p.consent.asserted).toLowerCase()})` : ""}${p.consent.at ? `, since ${day(p.consent.at)}` : ""}`
                : "None sent"
            }
          />
          <Pair label="Marketing email" value={p.reach.marketing ? "Allowed" : "Not allowed: service emails only"} />
          <Pair label="Can email" value={reach.why ?? "Yes"} />
        </dl>
        {p.optOuts.length ? (
          <ul className="space-y-0.5 text-sm">
            {p.optOuts.map((o, i) => (
              <li key={i}>
                {o.text} <span className="text-neutral-500">{o.at ? day(o.at) : ""}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  );
}

/** What each email did: one line each, newest first. */
function EmailList({ emails }: { emails: PersonEmail[] }) {
  return (
    <ul className="divide-y divide-neutral-100 text-sm dark:divide-neutral-900">
      {emails.map((e) => (
        <li key={`${e.enrolmentId}:${e.nodeId}:${e.itemId}:${e.at}`} className="grid grid-cols-1 gap-x-3 gap-y-1 py-2 sm:grid-cols-[5.5rem_minmax(0,1fr)] md:grid-cols-[5.5rem_minmax(0,1fr)_auto]">
          <span className="whitespace-nowrap text-xs text-neutral-500" title={dayTime(e.at)}>
            {day(e.at)}
          </span>
          <span className="min-w-0">
            <span className={`block break-words ${e.status === "skipped" ? "text-neutral-500 line-through" : "font-medium"}`}>{e.subject ?? e.label}</span>
            <span className="block text-xs text-neutral-500">
              {[e.subject ? e.label : null, e.journeyName, e.version === "ai" ? "with an AI line" : e.version === "fallback" ? "standard wording" : null, e.mode === "live" ? null : `${e.mode} mode`]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {e.line ? <span className="mt-0.5 block text-xs italic text-neutral-600 dark:text-neutral-400">“{e.line}”</span> : null}
          </span>
          <span className="flex flex-wrap items-center gap-1 sm:col-start-2 md:col-start-3 md:justify-end">
            <EmailMarks email={e} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function EmailMarks({ email: e }: { email: PersonEmail }) {
  if (e.status === "skipped") return <Chip>{e.note ?? "Skipped"}</Chip>;
  const opened = e.openedAt ?? e.clickedAt;
  const link = shortUrl(e.clickUrl);
  return (
    <>
      {e.status === "unknown" ? <Chip tone="amber">{e.note ?? "Unconfirmed"}</Chip> : null}
      {e.bounced ? <Chip tone="red">Bounced</Chip> : null}
      {e.complained ? <Chip tone="red">Marked as spam</Chip> : null}
      {e.unsubscribed ? <Chip tone="red">Unsubscribed</Chip> : null}
      {opened ? (
        <Chip tone="green" title={dayTime(opened)}>
          Opened {time(opened)}
        </Chip>
      ) : e.tracked.opens ? (
        <span className="text-xs text-neutral-500">Not opened</span>
      ) : e.mode === "shadow" ? null : (
        <span className="text-xs text-neutral-400" title="Open tracking was off for this email">
          Opens not tracked
        </span>
      )}
      {e.clickedAt ? (
        <Chip tone="blue" title={e.clickUrl ?? undefined}>
          Clicked{link ? ` ${link}` : ""}
        </Chip>
      ) : null}
    </>
  );
}

const MOMENT_DOT: Record<PersonMoment["kind"], string> = {
  product: "bg-neutral-900 dark:bg-neutral-100",
  email: "bg-sky-600",
  journey: "bg-green-600",
  stop: "bg-red-600",
};

/** How many moments show before "Show all". */
const STORY_FOLD = 12;

function Story({ moments }: { moments: PersonMoment[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? moments : moments.slice(0, STORY_FOLD);
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
        {(
          [
            ["product", "In the product"],
            ["email", "Email"],
            ["journey", "Journey"],
            ["stop", "Opt-out or bounce"],
          ] as const
        ).map(([kind, label]) => (
          <span key={kind} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`h-2 w-2 rounded-full ${MOMENT_DOT[kind]}`} />
            {label}
          </span>
        ))}
      </p>
      <ol className="space-y-1.5 text-sm">
        {shown.map((m, i) => (
          <li key={i} className="grid grid-cols-[4.75rem_0.5rem_minmax(0,1fr)] items-baseline gap-x-2 sm:grid-cols-[5.5rem_0.5rem_minmax(0,1fr)] sm:gap-x-3">
            <span className="whitespace-nowrap text-xs text-neutral-500" title={dayTime(m.at)}>
              {day(m.at)}
            </span>
            <span aria-hidden className={`h-2 w-2 self-center rounded-full ${MOMENT_DOT[m.kind]}`} />
            <span className="min-w-0 break-words">
              {m.text}
              {m.detail ? <span className="text-neutral-500"> · {m.kind === "email" && m.detail.startsWith("http") ? shortUrl(m.detail) : m.detail}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {moments.length > STORY_FOLD ? (
        <Button onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${moments.length}`}</Button>
      ) : null}
    </div>
  );
}
