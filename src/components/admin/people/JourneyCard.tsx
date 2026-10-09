"use client";

import Link from "next/link";
import { Play, Square } from "lucide-react";
import type { PersonEmail } from "@/lib/audience/personEmails";
import type { PersonJourney, PersonJourneyStep } from "@/lib/audience/personJourneys";
import { Badge, Button } from "../connect/ui";
import { Chip } from "./Chip";
import { day, dayTime } from "./format";

/**
 * One journey a person is in: what they were sent, where they are now, and the
 * emails ahead, as a rail. What's ahead is the sender's own walk on the state the
 * product last sent, so it's drawn lighter than what has happened.
 */

const DOT: Record<PersonJourneyStep["kind"], string> = {
  sent: "border-green-600 bg-green-600",
  unknown: "border-amber-500 bg-amber-100 dark:bg-amber-950",
  skipped: "border-neutral-400 bg-neutral-100 dark:bg-neutral-800",
  next: "border-sky-600 bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950",
  later: "border-neutral-400 bg-white dark:bg-neutral-950",
  would_skip: "border-dashed border-red-400 bg-white dark:bg-neutral-950",
};

/** The line from a step to the one after it: solid for what has happened, dashed for what's ahead. */
const AHEAD: ReadonlySet<PersonJourneyStep["kind"]> = new Set(["next", "later", "would_skip"]);

function StepNote({ step, email, timeZone }: { step: PersonJourneyStep; email: PersonEmail | undefined; timeZone: string | null }) {
  switch (step.kind) {
    case "sent": {
      // A click is an open too, even when the pixel was blocked.
      const clicked = Boolean(email?.clickedAt);
      const opened = clicked || Boolean(email?.openedAt);
      return (
        <>
          <span className="text-xs text-neutral-500">{day(step.at)}</span>
          {opened ? (
            <span className="flex flex-wrap gap-1">
              <Chip tone="green">Opened</Chip>
              {clicked ? <Chip tone="blue">Clicked</Chip> : null}
            </span>
          ) : null}
        </>
      );
    }
    case "unknown":
    case "skipped":
      return (
        <span className="text-xs text-neutral-500">
          {day(step.at)} · {step.reason ?? (step.kind === "skipped" ? "Skipped" : "Unconfirmed")}
        </span>
      );
    case "next":
      return (
        <span className="text-xs text-neutral-600 dark:text-neutral-400">
          Next · {dayTime(step.at, timeZone)}
          {timeZone ? " their time" : ""}
        </span>
      );
    case "would_skip":
      return (
        <span className="text-xs text-red-700 dark:text-red-400">
          {day(step.at, timeZone)} · won&rsquo;t send: {step.reason}
        </span>
      );
    default:
      return <span className="text-xs text-neutral-500">About {day(step.at, timeZone)}</span>;
  }
}

export function JourneyCard({
  journey: j,
  emails,
  timeZone,
  canEdit,
  busy,
  onRunNow,
  onStop,
}: {
  journey: PersonJourney;
  /** The person's emails, for what they did with each one sent here. */
  emails: PersonEmail[];
  timeZone: string | null;
  canEdit: boolean;
  busy: boolean;
  onRunNow: () => void;
  onStop: () => void;
}) {
  const mine = new Map(emails.filter((e) => e.enrolmentId === j.enrolmentId).map((e) => [`${e.nodeId}|${e.itemId}|${e.at}`, e]));
  const hasAhead = j.steps.some((s) => AHEAD.has(s.kind));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={`/admin/lifecycle/${j.journeyId}`} className="text-sm font-semibold hover:underline">
              {j.name}
            </Link>
            {j.status === "completed" ? <Badge tone="green">Finished</Badge> : j.status === "exited" ? <Badge tone="amber">Stopped</Badge> : <Badge>In progress</Badge>}
            {j.mode !== "live" ? <Badge>{j.mode} mode</Badge> : null}
            {j.status === "active" && j.journeyStatus === "paused" ? <Badge tone="amber">Journey paused</Badge> : null}
          </div>
          <p className="text-xs text-neutral-500">
            Entered {day(j.enteredAt)}
            {j.about ? ` · about ${j.about}` : ""}
            {j.status === "completed" ? ` · finished ${day(j.endedAt)}` : ""}
            {j.status === "exited" ? ` · stopped ${day(j.endedAt)}${j.stopped ? `: ${j.stopped}` : ""}` : ""}
          </p>
        </div>
        {canEdit && j.status === "active" ? (
          <div className="flex flex-wrap gap-2">
            <Button disabled={!j.canRunNow || busy} title={j.canRunNow ? undefined : "Only for test and shadow entries"} onClick={onRunNow}>
              <Play size={14} /> Run next step now
            </Button>
            <Button tone="danger" disabled={busy} onClick={onStop}>
              <Square size={14} /> Stop
            </Button>
          </div>
        ) : null}
      </div>

      {j.waiting?.why ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Held: {j.waiting.why}.{j.waiting.until ? ` It looks again ${dayTime(j.waiting.until)}.` : ""}
        </p>
      ) : null}

      {j.steps.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {j.status === "active" ? `Nothing sent yet.${j.waiting?.until ? ` It runs next ${dayTime(j.waiting.until)}.` : ""}` : "Nothing was sent."}
        </p>
      ) : (
        <ol className="flex flex-col md:flex-row">
          {j.steps.map((s, i) => {
            const last = i === j.steps.length - 1;
            return (
              <li key={`${s.nodeId}:${s.itemId}:${s.at}`} className="flex min-w-0 gap-3 md:flex-1 md:flex-col md:gap-2">
                <div className="flex flex-col items-center md:flex-row">
                  <span className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 ${DOT[s.kind]}`} aria-hidden />
                  {last ? null : (
                    <span
                      aria-hidden
                      className={`min-h-4 w-0 flex-1 border-l-2 md:min-h-0 md:w-auto md:border-l-0 md:border-t-2 ${
                        AHEAD.has(s.kind) ? "border-dashed border-neutral-300 dark:border-neutral-700" : "border-green-600"
                      }`}
                    />
                  )}
                </div>
                <div className="flex min-w-0 flex-col gap-0.5 pb-3 md:pb-0 md:pr-3">
                  <span className={`text-sm ${AHEAD.has(s.kind) && s.kind !== "next" ? "text-neutral-600 dark:text-neutral-400" : "font-medium"}`}>
                    {s.label}
                    {s.personalised && AHEAD.has(s.kind) ? <span className="font-normal text-neutral-500"> · AI line</span> : null}
                  </span>
                  <StepNote step={s} email={mine.get(`${s.nodeId}|${s.itemId}|${s.at}`)} timeZone={timeZone} />
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {j.then || hasAhead ? (
        <p className="text-xs text-neutral-500">
          {j.then ? (j.then.kind === "finishes" ? "Then the journey finishes. " : `Then it stops${j.then.why ? `: ${j.then.why}` : ""}. `) : null}
          {hasAhead ? "What's ahead follows what your product last told us, so it can change as they do things." : null}
        </p>
      ) : null}
    </div>
  );
}
