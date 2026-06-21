"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  EmailAnalytics,
  NodeBreakdown,
  ArmBreakdown,
} from "@/lib/analytics/email";
import { confidenceHint } from "@/lib/analytics/significance";

/** Mirror of the server-side promote gate so the button disables before the POST. */
const MIN_SAMPLE = 50;

const pct = (r: number) => `${Math.round(r * 100)}%`;

export function EmailAnalyticsSection({ campaignId }: { campaignId: string }) {
  const [data, setData] = useState<EmailAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [breakdowns, setBreakdowns] = useState<Record<string, NodeBreakdown[]>>({});
  const [breakdownLoading, setBreakdownLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/admin/campaigns/${campaignId}/analytics/emails`);
    setLoading(false);
    if (!res.ok) {
      setError("Couldn't load email analytics.");
      return;
    }
    const json = await res.json().catch(() => null);
    setData(json?.analytics ?? null);
    setError(null);
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadBreakdown = useCallback(
    async (journeyId: string) => {
      setBreakdownLoading(journeyId);
      const res = await fetch(
        `/api/admin/campaigns/${campaignId}/analytics/emails/${journeyId}`,
      );
      setBreakdownLoading(null);
      if (!res.ok) return;
      const json = await res.json().catch(() => null);
      const nodes: NodeBreakdown[] = json?.breakdown?.nodes ?? [];
      setBreakdowns((prev) => ({ ...prev, [journeyId]: nodes }));
    },
    [campaignId],
  );

  function toggle(journeyId: string) {
    if (expanded === journeyId) {
      setExpanded(null);
      return;
    }
    setExpanded(journeyId);
    if (!breakdowns[journeyId]) void loadBreakdown(journeyId);
  }

  async function promote(nodeId: string, winnerVariantId: string, journeyId: string) {
    if (!window.confirm("Promote this version as the winner? Future sends will use it.")) {
      return;
    }
    const res = await fetch(`/api/admin/campaigns/${campaignId}/journey/abtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "promote", nodeId, winnerVariantId }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      window.alert(
        json.error === "insufficient_data"
          ? `Not enough data yet — need at least ${MIN_SAMPLE} sends for that version.`
          : "Promotion failed. Please try again.",
      );
      return;
    }
    await Promise.all([load(), loadBreakdown(journeyId)]);
  }

  if (loading) {
    return <Section><Empty>Loading email analytics…</Empty></Section>;
  }
  if (error) {
    return <Section><Empty>{error}</Empty></Section>;
  }
  if (!data || (data.sequences.length === 0 && data.broadcasts.length === 0)) {
    return (
      <Section>
        <Empty>No emails sent yet. Engagement appears here once a journey or broadcast goes out.</Empty>
      </Section>
    );
  }

  return (
    <Section>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Emails sent" value={data.cards.sends.toLocaleString()} />
        <Stat label="Delivery rate" value={pct(data.cards.deliveryRate)} />
        <Stat label="Open rate" value={pct(data.cards.openRate)} />
        <Stat label="Click rate" value={pct(data.cards.clickRate)} />
      </div>

      <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-neutral-200 text-neutral-500 dark:border-neutral-800">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 text-right font-medium">Enrolled</th>
              <th className="px-3 py-2 text-right font-medium">Delivery</th>
              <th className="px-3 py-2 text-right font-medium">Open rate</th>
              <th className="px-3 py-2 text-right font-medium">Click rate</th>
            </tr>
          </thead>
          <tbody>
            {data.sequences.map((s) => {
              const isOpen = expanded === s.id;
              return (
                <FragmentRow key={s.id}>
                  <tr
                    onClick={() => toggle(s.id)}
                    className="cursor-pointer border-b border-neutral-100 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900/50"
                  >
                    <td className="px-3 py-2">
                      <span className="mr-1 text-neutral-400">{isOpen ? "▾" : "▸"}</span>
                      {s.name}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.enrolled.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(s.delivered / Math.max(1, s.sent))}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(s.openRate)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(s.clickRate)}</td>
                  </tr>
                  {isOpen ? (
                    <tr className="border-b border-neutral-100 dark:border-neutral-900">
                      <td colSpan={5} className="bg-neutral-50/50 px-3 py-3 dark:bg-neutral-900/30">
                        {breakdownLoading === s.id ? (
                          <p className="text-xs text-neutral-500">Loading emails…</p>
                        ) : (
                          <SequenceBreakdown
                            nodes={breakdowns[s.id] ?? []}
                            onPromote={(nodeId, vid) => promote(nodeId, vid, s.id)}
                          />
                        )}
                      </td>
                    </tr>
                  ) : null}
                </FragmentRow>
              );
            })}
            {data.broadcasts.map((b) => (
              <tr key={b.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                <td className="px-3 py-2">
                  <span className="mr-1 rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] uppercase text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                    Broadcast
                  </span>
                  {b.name}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{b.enrolled.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums">{b.pending ? "—" : pct(1)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{b.pending ? "—" : pct(b.openRate)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{b.pending ? "—" : pct(b.clickRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function SequenceBreakdown({
  nodes,
  onPromote,
}: {
  nodes: NodeBreakdown[];
  onPromote: (nodeId: string, winnerVariantId: string) => void;
}) {
  if (nodes.length === 0) {
    return <p className="text-xs text-neutral-500">No emails in this sequence yet.</p>;
  }
  return (
    <div className="space-y-3">
      {nodes.map((n) => (
        <div key={n.nodeId} className="rounded-md border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-950">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{n.label}</span>
            {n.abTest ? (
              <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                {n.status === "promoted" ? "A/B promoted" : "A/B running"}
              </span>
            ) : null}
          </div>
          {n.abTest && n.arms.length > 0 ? (
            <ArmTable
              nodeId={n.nodeId}
              arms={n.arms}
              status={n.status}
              winnerVariantId={n.winnerVariantId ?? null}
              onPromote={onPromote}
            />
          ) : (
            <div className="mt-1 flex gap-4 text-xs tabular-nums text-neutral-500">
              <span>{n.sent.toLocaleString()} sent</span>
              <span>{pct(n.openRate)} open</span>
              <span>{pct(n.clickRate)} click</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ArmTable({
  nodeId,
  arms,
  status,
  winnerVariantId,
  onPromote,
}: {
  nodeId: string;
  arms: ArmBreakdown[];
  status?: "running" | "promoted";
  winnerVariantId: string | null;
  onPromote: (nodeId: string, winnerVariantId: string) => void;
}) {
  const control = arms.find((a) => a.variantId === "control");
  return (
    <table className="mt-2 w-full text-left text-xs">
      <thead className="text-neutral-400">
        <tr>
          <th className="py-1 font-medium">Version</th>
          <th className="py-1 text-right font-medium">Sent</th>
          <th className="py-1 text-right font-medium">Open</th>
          <th className="py-1 text-right font-medium">Click</th>
          <th className="py-1 text-right font-medium">Confidence</th>
          <th className="py-1 text-right font-medium"></th>
        </tr>
      </thead>
      <tbody>
        {arms.map((a) => {
          const isWinner = status === "promoted" && winnerVariantId === a.variantId;
          const hint =
            control && a.variantId !== "control"
              ? confidenceHint(
                  { conversions: a.opened, sample: a.delivered },
                  { conversions: control.opened, sample: control.delivered },
                )
              : null;
          const canPromote = status !== "promoted" && a.sent >= MIN_SAMPLE;
          return (
            <tr key={a.variantId} className="border-t border-neutral-100 dark:border-neutral-900">
              <td className="py-1">
                {a.label}
                {isWinner ? <span className="ml-1 text-green-600 dark:text-green-400">✓ winner</span> : null}
              </td>
              <td className="py-1 text-right tabular-nums">{a.sent.toLocaleString()}</td>
              <td className="py-1 text-right tabular-nums">{pct(a.openRate)}</td>
              <td className="py-1 text-right tabular-nums">{pct(a.clickRate)}</td>
              <td className="py-1 text-right">
                {hint ? <ConfidenceTag value={hint} /> : <span className="text-neutral-300">—</span>}
              </td>
              <td className="py-1 text-right">
                {status !== "promoted" ? (
                  <button
                    type="button"
                    disabled={!canPromote}
                    title={canPromote ? undefined : `Needs ≥${MIN_SAMPLE} sends`}
                    onClick={() => onPromote(nodeId, a.variantId)}
                    className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-900"
                  >
                    Promote
                  </button>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ConfidenceTag({ value }: { value: "low" | "emerging" | "clear" }) {
  const styles: Record<string, string> = {
    low: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
    emerging: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    clear: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${styles[value]}`}>
      {value}
    </span>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">Emails</h2>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-neutral-300 px-3 py-4 text-center text-xs text-neutral-400 dark:border-neutral-700">
      {children}
    </p>
  );
}

/** Render two sibling rows without a wrapper element (tables reject divs). */
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
