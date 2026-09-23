"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Eye, RefreshCw, SkipForward, Undo2 } from "lucide-react";
import { validateAiLine, validateAiSubject } from "@/lib/lifecycle/insightValidator";
import { escapeHtml } from "@/lib/email/emailRender";
import { api, errorText, timeAgo } from "../connect/api";
import { Badge, Banner, Button, Field, Tabs, inputClass } from "../connect/ui";
import { isNavV2Enabled } from "@/lib/nav/flags";

/**
 * The Approval Queue: per-person AI lines for lifecycle emails, written ahead
 * from the product's own insight. Approve (edit first if you like — edits are
 * checked as you type and again on the server), send the standard version, or
 * skip the email. Undecided lines fall back to the standard version at send.
 */

interface Draft {
  id: string;
  journeyId: string;
  journeyName: string | null;
  itemLabel: string;
  externalUserId: string;
  user: { email: string | null; firstName: string | null } | null;
  status: "awaiting_approval" | "approved" | "use_fallback" | "skipped" | "used" | "pending" | "superseded";
  requireApproval: boolean;
  sendAt: string;
  approvalDeadline: string;
  closed: boolean;
  insightSentence: string | null;
  aiLine: string | null;
  subjectVariant: string | null;
  standardSubject: string | null;
  factsSnapshot: Array<{ id: string; label: string; display: string }>;
  allowedTerms: string[];
  attestedTerms: string[];
  validationIssues: string[];
  fallbackReason: string | null;
  draftVersion: number;
  decidedBy: string | null;
  decidedAt: string | null;
  usedVersion: "ai" | "fallback" | "skip" | null;
  previewHtml: string | null;
}

const REASONS: Record<string, string> = {
  staff_choice: "you chose the standard version",
  no_decision: "no decision before the send",
  insight_stale: "the insight had changed by send time",
  validation_failed: "the line didn't pass the checks",
  generation_failed: "the AI couldn't write a line",
  no_insight: "the product had no insight for this person",
  draft_cap: "today's AI draft limit was reached",
  superseded: "the person took a different path",
  ai_off: "AI lines are switched off",
  changed_during_send: "it was edited while sending",
  render_failed: "the AI version couldn't be rendered",
  no_draft: "no line was prepared",
};

function when(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  const abs = Math.abs(ms);
  const h = Math.round(abs / 3_600_000);
  const rel = abs < 3_600_000 ? `${Math.round(abs / 60_000)} min` : h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
  const local = new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return ms >= 0 ? `in ${rel} (${local})` : `${rel} ago`;
}

/**
 * `embedded`: shown as the AI-lines section of the nav v2 Review page, which
 * supplies the heading and explanation, so the queue's own are left out.
 */
export function ApprovalQueue({ canEdit, embedded = false }: { canEdit: boolean; embedded?: boolean }) {
  const [tab, setTab] = useState<"waiting" | "decided">("waiting");
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);

  const load = useCallback(async () => {
    setDrafts(null);
    const r = await api<{ drafts: Draft[] }>(`/api/admin/approvals?view=${tab}`);
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    setDrafts(r.data.drafts);
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <div hidden={embedded}>
        <h1 className="text-lg font-semibold">{isNavV2Enabled() ? "Review" : "Approval Queue"}</h1>
        <p className="max-w-3xl text-sm text-neutral-500 dark:text-neutral-400">
          Personal lines for upcoming lifecycle emails, written from each person&rsquo;s own results. Numbers only ever
          come from your product&rsquo;s insight; the AI line can&rsquo;t add any. Anything you don&rsquo;t decide in time goes
          out as the standard version.
        </p>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Tabs
          tabs={[
            { id: "waiting", label: "Waiting" },
            { id: "decided", label: "Decided" },
          ]}
          value={tab}
          onChange={(t) => setTab(t)}
        />
        <Button onClick={() => void load()}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
      {drafts === null ? <p className="text-sm text-neutral-500">Loading…</p> : null}
      {drafts?.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          {tab === "waiting" ? "Nothing waiting. New lines appear about 12 hours before their email is due." : "Nothing decided yet."}
        </p>
      ) : null}
      <ul className="space-y-3">
        {drafts?.map((d) =>
          tab === "waiting" ? (
            <li key={d.id}>
              <DraftCard
                draft={d}
                canEdit={canEdit}
                onDone={(text) => {
                  setMsg({ tone: "ok", text });
                  setDrafts((ds) => ds?.filter((x) => x.id !== d.id) ?? null);
                }}
                onStale={(text) => {
                  setMsg({ tone: "info", text });
                  void load();
                }}
              />
            </li>
          ) : (
            <li key={d.id}>
              <DecidedRow draft={d} />
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function DraftCard({
  draft,
  canEdit,
  onDone,
  onStale,
}: {
  draft: Draft;
  canEdit: boolean;
  onDone: (text: string) => void;
  onStale: (text: string) => void;
}) {
  const [line, setLine] = useState(draft.aiLine ?? "");
  const [subject, setSubject] = useState(draft.subjectVariant ?? "");
  const [attested, setAttested] = useState(draft.attestedTerms.join(", "));
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverIssues, setServerIssues] = useState<string[]>([]);

  const attestedList = useMemo(
    () =>
      attested
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20),
    [attested],
  );
  const allowed = useMemo(() => [...draft.allowedTerms, ...attestedList], [draft.allowedTerms, attestedList]);
  const lineCheck = useMemo(() => validateAiLine(line, allowed), [line, allowed]);
  const subjectCheck = useMemo(() => (subject.trim() ? validateAiSubject(subject, allowed) : { ok: true, issues: [] }), [subject, allowed]);
  const issues = [...lineCheck.issues, ...subjectCheck.issues];
  const edited = line.trim() !== (draft.aiLine ?? "") || (subject.trim() || null) !== draft.subjectVariant;
  const previewHtml = useMemo(
    () => (preview && draft.previewHtml && draft.aiLine ? draft.previewHtml.split(escapeHtml(draft.aiLine)).join(escapeHtml(line.trim())) : draft.previewHtml),
    [preview, draft.previewHtml, draft.aiLine, line],
  );

  const decide = async (action: "approve" | "fallback" | "skip") => {
    setBusy(true);
    setServerIssues([]);
    const r = await api<{ draft: Draft; error?: string; detail?: string[] }>(`/api/admin/approvals/${draft.id}/decide`, {
      method: "POST",
      body: JSON.stringify({
        action,
        draftVersion: draft.draftVersion,
        ...(action === "approve" ? { aiLine: line.trim(), subjectVariant: subject.trim() || null, attestedTerms: attestedList } : {}),
      }),
    });
    setBusy(false);
    if (r.ok) {
      const who = draft.user?.email ?? draft.externalUserId;
      onDone(action === "approve" ? `Approved for ${who}.` : action === "fallback" ? `${who} gets the standard version.` : `Skipped for ${who}.`);
      return;
    }
    const body = r.data as unknown as { error?: string; detail?: string[] };
    if (r.status === 422 && Array.isArray(body.detail)) return setServerIssues(body.detail);
    if (r.status === 409) return onStale(body.error === "closed" ? "That one's too close to its send time — it will go out as the standard version." : "That line changed — reloaded.");
    setServerIssues([errorText(r.data)]);
  };

  return (
    <article className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">
            {draft.itemLabel}{" "}
            <span className="font-normal text-neutral-500">
              ·{" "}
              <Link href={`/admin/lifecycle/${draft.journeyId}`} className="hover:underline">
                {draft.journeyName ?? "journey"}
              </Link>
            </span>
          </div>
          <div className="text-xs text-neutral-500">
            To {draft.user?.email ?? draft.externalUserId} · sends {when(draft.sendAt)}
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {draft.requireApproval ? <Badge tone="amber">backfill — won&rsquo;t send unless approved</Badge> : null}
          {draft.closed ? <Badge tone="red">closed</Badge> : <Badge>decide {when(draft.approvalDeadline)}</Badge>}
        </div>
      </header>

      <div className="space-y-1">
        <span className="text-xs font-medium text-neutral-500">The product&rsquo;s insight (sent as written)</span>
        <blockquote className="border-l-2 border-neutral-300 pl-3 text-sm dark:border-neutral-700">{draft.insightSentence}</blockquote>
        {draft.factsSnapshot.length ? (
          <p className="text-xs text-neutral-500">
            Facts: {draft.factsSnapshot.map((f) => `${f.label}: ${f.display}`).join(" · ")}
          </p>
        ) : null}
      </div>

      <Field label="AI line (follows the insight)">
        <textarea className={`${inputClass} min-h-16`} value={line} disabled={!canEdit || draft.closed} onChange={(e) => setLine(e.target.value.slice(0, 400))} />
      </Field>
      <Field label="Subject" hint={`Leave blank for the standard subject: “${draft.standardSubject ?? ""}”`}>
        <input className={inputClass} value={subject} disabled={!canEdit || draft.closed} onChange={(e) => setSubject(e.target.value.slice(0, 120))} />
      </Field>
      {issues.length || serverIssues.length ? (
        <div className="space-y-2">
          <ul className="list-disc space-y-0.5 rounded-md border border-red-200 bg-red-50 py-2 pl-7 pr-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {[...new Set([...issues, ...serverIssues])].map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
          {issues.some((i) => i.startsWith("Names")) ? (
            <Field label="Vouch for names (comma-separated)" hint="Only if the name is accurate for this person — it's added to what this line may mention.">
              <input className={inputClass} value={attested} disabled={!canEdit} onChange={(e) => setAttested(e.target.value)} />
            </Field>
          ) : null}
        </div>
      ) : null}

      {canEdit && !draft.closed ? (
        <div className="flex flex-wrap gap-2">
          <Button tone="primary" disabled={busy || !lineCheck.ok || !subjectCheck.ok} onClick={() => void decide("approve")}>
            <Check size={14} /> {edited ? "Save & approve" : "Approve"}
          </Button>
          <Button disabled={busy} onClick={() => void decide("fallback")}>
            <Undo2 size={14} /> Use standard version
          </Button>
          <Button disabled={busy} onClick={() => void decide("skip")}>
            <SkipForward size={14} /> Skip this email
          </Button>
          <Button disabled={!draft.previewHtml} onClick={() => setPreview(!preview)}>
            <Eye size={14} /> {preview ? "Hide preview" : "Preview"}
          </Button>
        </div>
      ) : (
        <Button disabled={!draft.previewHtml} onClick={() => setPreview(!preview)}>
          <Eye size={14} /> {preview ? "Hide preview" : "Preview"}
        </Button>
      )}
      {preview && previewHtml ? (
        <iframe title={`Preview for ${draft.user?.email ?? draft.externalUserId}`} sandbox="" srcDoc={previewHtml} className="h-[520px] w-full rounded-md border border-neutral-200 bg-white dark:border-neutral-800" />
      ) : null}
    </article>
  );
}

function DecidedRow({ draft }: { draft: Draft }) {
  const outcome =
    draft.status === "used"
      ? draft.usedVersion === "ai"
        ? "Sent with the AI line"
        : draft.usedVersion === "skip"
          ? "Not sent"
          : `Sent as standard — ${REASONS[draft.fallbackReason ?? ""] ?? draft.fallbackReason ?? "standard"}`
      : draft.status === "approved"
        ? "Approved — sending soon"
        : draft.status === "skipped"
          ? "Skipped"
          : `Standard version — ${REASONS[draft.fallbackReason ?? ""] ?? draft.fallbackReason ?? ""}`;
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-neutral-200 px-4 py-3 text-sm dark:border-neutral-800">
      <div className="min-w-0">
        <div className="font-medium">
          {draft.itemLabel} <span className="font-normal text-neutral-500">· {draft.user?.email ?? draft.externalUserId}</span>
        </div>
        {draft.aiLine ? <p className="mt-1 text-neutral-600 dark:text-neutral-300">&ldquo;{draft.aiLine}&rdquo;</p> : null}
        <p className="mt-1 text-xs text-neutral-500">
          {outcome}
          {draft.decidedBy ? ` · decided by ${draft.decidedBy} ${timeAgo(draft.decidedAt)}` : ""}
        </p>
      </div>
      <Badge tone={draft.usedVersion === "ai" || draft.status === "approved" ? "green" : draft.status === "skipped" || draft.usedVersion === "skip" ? "neutral" : "amber"}>
        {draft.status === "used" ? draft.usedVersion ?? "sent" : draft.status.replace("_", " ")}
      </Badge>
    </div>
  );
}
