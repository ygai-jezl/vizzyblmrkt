"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { Play, RefreshCw, Square, UserPlus } from "lucide-react";
import type { LifecycleDraft, LifecycleJourney } from "@/lib/types/lifecycle";
import { api, errorText, timeAgo } from "../connect/api";
import { Badge, Banner, Button, Field, Section, inputClass } from "../connect/ui";
import { nodeLabel, type EnrolmentRow } from "./model";

const RUN_NOW_MESSAGES: Record<string, string> = {
  draft_prepared: "Prepared the personalised version of the next email — review it in Approvals, then press Run now again to send.",
  draft_fallback: "The personalised version couldn't be prepared, so the next email will use the standard wording. Press Run now again to send it.",
  sent: "Sent.",
};

/** Who's in the journey, where each person is up to, and what they've been sent. */
export function EnrolmentsPanel({
  journey,
  draft,
  sandboxUserIds,
  canEdit,
}: {
  journey: LifecycleJourney;
  draft: LifecycleDraft;
  sandboxUserIds: string[];
  canEdit: boolean;
}) {
  const [rows, setRows] = useState<EnrolmentRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [userId, setUserId] = useState(sandboxUserIds[0] ?? "");
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ enrolments: EnrolmentRow[] }>(`/api/admin/lifecycle/journeys/${journey.id}/enrolments?limit=200`);
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    setRows(r.data.enrolments);
  }, [journey.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, path: string, body?: unknown, done?: (data: Record<string, unknown>) => string) => {
    setBusy(key);
    setMsg(null);
    const r = await api<Record<string, unknown>>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
    setBusy(null);
    if (!r.ok) setMsg({ tone: "err", text: errorText(r.data) });
    else if (done) setMsg({ tone: "ok", text: done(r.data) });
    await load();
  };

  const canEnrol = canEdit && journey.status === "active" && journey.publishedVersion;

  return (
    <div className="space-y-4">
      {canEdit ? (
        <Section
          title="Enrol someone now"
          description="Put an existing user of the product into the journey by hand, using the product's own user id. In test mode they must be a test user."
        >
          <div className="flex flex-wrap items-end gap-2">
            <Field label="User id">
              <input className={`${inputClass} w-64 font-mono`} value={userId} list="lc-sandbox-users" onChange={(e) => setUserId(e.target.value)} />
              <datalist id="lc-sandbox-users">
                {sandboxUserIds.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </Field>
            <Button
              tone="primary"
              disabled={!canEnrol || !userId.trim() || busy === "enrol"}
              onClick={() => void act("enrol", `/api/admin/lifecycle/journeys/${journey.id}/enrolments`, { userId: userId.trim() }, () => "Enrolled. The first step runs on the next tick (within 2 minutes).")}
            >
              <UserPlus size={14} /> Enrol
            </Button>
          </div>
          {!canEnrol && canEdit ? <p className="text-xs text-neutral-500">Publish the journey (and keep it active) to enrol people.</p> : null}
        </Section>
      ) : null}

      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Enrolments {rows ? `(${rows.length})` : ""}</h3>
        <Button onClick={() => void load()}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>
      {rows === null ? <p className="text-sm text-neutral-500">Loading…</p> : null}
      {rows?.length === 0 ? <p className="text-sm text-neutral-500">No one has entered this journey yet.</p> : null}
      {rows && rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs text-neutral-500 dark:bg-neutral-900">
              <tr>
                <th className="px-3 py-2">Person</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Up to</th>
                <th className="px-3 py-2">Next run</th>
                <th className="px-3 py-2">Emails</th>
                <th className="px-3 py-2">Latest</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const last = e.log[e.log.length - 1];
                return (
                  <Fragment key={e.id}>
                    <tr className="cursor-pointer border-t border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900" onClick={() => setOpen(open === e.id ? null : e.id)}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{e.user?.email ?? e.externalUserId}</div>
                        <div className="font-mono text-xs text-neutral-500">{e.externalUserId}</div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={e.status === "active" ? "green" : e.status === "completed" ? "neutral" : "amber"}>{e.status}</Badge>{" "}
                        <Badge>{e.mode}</Badge>
                        {e.stopReason ? <div className="text-xs text-neutral-500">{e.stopReason}</div> : null}
                      </td>
                      <td className="px-3 py-2">{nodeLabel(draft, e.cursor?.nodeId)}</td>
                      <td className="px-3 py-2 text-xs">{e.nextRunAt ? new Date(e.nextRunAt).toLocaleString() : "—"}</td>
                      <td className="px-3 py-2">{e.sentItems.filter((s) => s.status !== "skipped").length}</td>
                      <td className="px-3 py-2 text-xs text-neutral-500">
                        {last ? `${last.event.replace(/_/g, " ")} · ${timeAgo(last.at)}` : "—"}
                      </td>
                    </tr>
                    {open === e.id ? (
                      <tr className="border-t border-neutral-200 bg-neutral-50/50 dark:border-neutral-800 dark:bg-neutral-900/40">
                        <td colSpan={6} className="space-y-3 px-3 py-3">
                          {canEdit && e.status === "active" ? (
                            <div className="flex flex-wrap gap-2">
                              <Button
                                disabled={e.mode === "live" || busy === `run:${e.id}`}
                                title={e.mode === "live" ? "Only for test and shadow enrolments" : undefined}
                                onClick={() => void act(`run:${e.id}`, `/api/admin/lifecycle/enrolments/${e.id}/run-now`, undefined, (d) => RUN_NOW_MESSAGES[String(d.outcome)] ?? `Ran: ${String(d.outcome)}`)}
                              >
                                <Play size={14} /> Run next step now
                              </Button>
                              <Button
                                tone="danger"
                                disabled={busy === `stop:${e.id}`}
                                onClick={() => {
                                  if (window.confirm("Take this person out of the journey?")) {
                                    void act(`stop:${e.id}`, `/api/admin/lifecycle/enrolments/${e.id}/stop`, undefined, () => "Stopped.");
                                  }
                                }}
                              >
                                <Square size={14} /> Stop
                              </Button>
                            </div>
                          ) : null}
                          <div className="grid gap-4 md:grid-cols-2">
                            <div>
                              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">Sent</h4>
                              {e.sentItems.length === 0 ? <p className="text-xs text-neutral-500">Nothing yet.</p> : null}
                              <ul className="space-y-1 text-xs">
                                {e.sentItems.map((s, i) => (
                                  <li key={i}>
                                    <span className="font-medium">{draft.pools.find((p) => p.id === s.poolId)?.items.find((x) => x.id === s.itemId)?.label ?? s.itemId}</span>{" "}
                                    <Badge tone={s.status === "sent" ? "green" : "amber"}>{s.status}</Badge> <span className="text-neutral-500">{new Date(s.at).toLocaleString()} · {s.mode}</span>
                                    {s.reason ? <span className="text-neutral-500"> · {s.reason}</span> : null}
                                  </li>
                                ))}
                              </ul>
                            </div>
                            <div>
                              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">Log</h4>
                              <ul className="max-h-60 space-y-1 overflow-auto text-xs">
                                {[...e.log].reverse().map((l, i) => (
                                  <li key={i}>
                                    <span className="text-neutral-500">{new Date(l.at).toLocaleString()}</span> {l.event.replace(/_/g, " ")}
                                    {l.detail ? <span className="text-neutral-500"> — {l.detail}</span> : null}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
