"use client";

import { useState } from "react";
import { Check, Pencil, Sparkles, X } from "lucide-react";
import type { PersonRecord } from "@/lib/audience/personRecord";
import { PLAN_LIMITS, type PersonPlan, type PlanBody } from "@/lib/types/personPlan";
import { api, errorText } from "../connect/api";
import { Banner, Button, Field, inputClass } from "../connect/ui";
import { day } from "./format";

/**
 * One person's plan: what to help them do next, and how to put it. Vizzy drafts
 * it from their situation (or you write it); only you approve it. An approved
 * plan shapes their personalised line, which still goes through Approvals. A plan
 * sends nothing by itself.
 */

type Plan = NonNullable<PersonRecord["plan"]>;
type Body = Pick<PlanBody, "goal" | "angle" | "next" | "reviewOn">;

const EMPTY: Body = { goal: "", angle: "", next: [], reviewOn: null };

function PlanBodyView({ plan }: { plan: Body }) {
  return (
    <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      <dt className="text-neutral-500">Goal</dt>
      <dd className="font-medium">{plan.goal}</dd>
      <dt className="text-neutral-500">Angle</dt>
      <dd className="whitespace-pre-line">{plan.angle}</dd>
      {plan.next.length ? (
        <>
          <dt className="text-neutral-500">Next</dt>
          <dd>
            <ol className="list-decimal space-y-0.5 pl-5">
              {plan.next.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </dd>
        </>
      ) : null}
      {plan.reviewOn ? (
        <>
          <dt className="text-neutral-500">Review</dt>
          {/* A plain day: read as that day everywhere, not shifted into the viewer's zone. */}
          <dd>{day(plan.reviewOn, "UTC")}</dd>
        </>
      ) : null}
    </dl>
  );
}

export function PlanPanel({
  personId,
  plan,
  cannotEmail,
  canEdit,
  onAskVizzy,
  onChanged,
}: {
  personId: string;
  plan: Plan;
  /** Why they can't be emailed at all, when they can't: a plan then changes nothing they get. */
  cannotEmail: string | null;
  canEdit: boolean;
  /** Ask Vizzy to draft one (null when Vizzy isn't here). */
  onAskVizzy: (() => void) | null;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Body | null>(null);
  const [steps, setSteps] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/admin/audience/people/${encodeURIComponent(personId)}/plan`;

  const edit = (from: Body) => {
    setEditing({ goal: from.goal, angle: from.angle, next: from.next, reviewOn: from.reviewOn });
    setSteps(from.next.join("\n"));
    setError(null);
  };
  const run = async (key: string, init: RequestInit) => {
    setBusy(key);
    setError(null);
    const r = await api<{ plan: PersonPlan }>(path, init);
    setBusy(null);
    if (!r.ok) return setError(errorText(r.data));
    setEditing(null);
    await onChanged();
  };
  const act = (action: "approve" | "discard_draft" | "end_plan") => run(action, { method: "POST", body: JSON.stringify({ action }) });
  const save = () => {
    if (!editing) return;
    const next = steps
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, PLAN_LIMITS.steps);
    return run("save", { method: "PUT", body: JSON.stringify({ ...editing, next }) });
  };

  if (editing) {
    return (
      <div className="space-y-3">
        {error ? <Banner tone="err">{error}</Banner> : null}
        <Field label="Goal" hint="What you want them to do next.">
          <input className={inputClass} maxLength={PLAN_LIMITS.goal} value={editing.goal} onChange={(e) => setEditing({ ...editing, goal: e.target.value })} placeholder="Connect their site" />
        </Field>
        <Field label="Angle" hint="How to put it to them: what to lead with, what to leave out. Say “they”, never their name.">
          <textarea className={`${inputClass} min-h-24`} maxLength={PLAN_LIMITS.angle} value={editing.angle} onChange={(e) => setEditing({ ...editing, angle: e.target.value })} />
        </Field>
        <Field label="Next steps" hint={`One per line, up to ${PLAN_LIMITS.steps}.`}>
          <textarea className={`${inputClass} min-h-20`} value={steps} onChange={(e) => setSteps(e.target.value)} />
        </Field>
        <Field label="Review on">
          <input type="date" className={`${inputClass} w-48`} value={editing.reviewOn ?? ""} onChange={(e) => setEditing({ ...editing, reviewOn: e.target.value || null })} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button tone="primary" disabled={busy !== null || !editing.goal.trim() || !editing.angle.trim()} onClick={() => void save()}>
            {busy === "save" ? "Saving…" : "Save as a draft"}
          </Button>
          <Button disabled={busy !== null} onClick={() => setEditing(null)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const { draft, approved } = plan;
  return (
    <div className="space-y-3">
      {error ? <Banner tone="err">{error}</Banner> : null}
      {cannotEmail ? <Banner tone="info">{cannotEmail}, so a plan won&rsquo;t change what they get.</Banner> : null}

      {draft ? (
        <div className="overflow-hidden rounded-md border border-sky-200 dark:border-sky-900">
          <div className="flex flex-wrap items-center justify-between gap-2 bg-sky-50 px-3 py-2 text-sm dark:bg-sky-950/40">
            <span className="font-semibold">Draft by {draft.by === "agent" ? "Vizzy" : "your team"}</span>
            <span className="text-xs text-neutral-600 dark:text-neutral-400">
              {day(draft.at)} · needs your approval{approved ? " · replaces the plan in force" : ""}
            </span>
          </div>
          <div className="space-y-3 p-3">
            <PlanBodyView plan={draft} />
            {canEdit ? (
              <div className="flex flex-wrap gap-2">
                <Button tone="primary" disabled={busy !== null} onClick={() => void act("approve")}>
                  <Check size={14} /> {busy === "approve" ? "Approving…" : "Approve plan"}
                </Button>
                <Button disabled={busy !== null} onClick={() => edit(draft)}>
                  <Pencil size={14} /> Edit
                </Button>
                <Button disabled={busy !== null} onClick={() => void act("discard_draft")}>
                  <X size={14} /> Discard
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {approved ? (
        <div className="overflow-hidden rounded-md border border-green-200 dark:border-green-900">
          <div className="flex flex-wrap items-center justify-between gap-2 bg-green-50 px-3 py-2 text-sm dark:bg-green-950/40">
            <span className="font-semibold">In force</span>
            <span className="text-xs text-neutral-600 dark:text-neutral-400">
              Approved {day(approved.at)}
              {approved.approvedBy ? ` by ${approved.approvedBy}` : ""} · shapes their personalised line
            </span>
          </div>
          <div className="space-y-3 p-3">
            <PlanBodyView plan={approved} />
            {canEdit && !draft ? (
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy !== null} onClick={() => edit(approved)}>
                  <Pencil size={14} /> Change it
                </Button>
                <Button disabled={busy !== null} onClick={() => void act("end_plan")}>
                  <X size={14} /> {busy === "end_plan" ? "Ending…" : "End plan"}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {!draft && !approved ? (
        <div className="space-y-3">
          <p className="text-sm text-neutral-500">No plan yet.{onAskVizzy ? " Vizzy can draft one from what's on this page, for you to approve." : ""}</p>
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              {onAskVizzy ? (
                <Button tone="primary" onClick={onAskVizzy}>
                  <Sparkles size={14} /> Ask Vizzy to draft one
                </Button>
              ) : null}
              <Button onClick={() => edit(EMPTY)}>
                <Pencil size={14} /> Write one
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
