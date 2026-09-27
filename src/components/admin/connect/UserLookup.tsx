"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { UserView } from "@/lib/connect/v2/contract";
import { api, errorText, timeAgo } from "./api";
import { Badge, Banner, Button, inputClass } from "./ui";

interface Write {
  at: string;
  type: string;
  event: string | null;
  applied: boolean;
  skipped: string | null;
  payload: Record<string, unknown>;
  ignoredFields: string[];
}

type Lookup =
  | { found: false; erasedAt?: string }
  | {
      found: true;
      user: Omit<UserView, "enrolments"> & { enrolments: Array<UserView["enrolments"][number] & { journeyName: string | null }> };
      effectiveConsent: string | null;
      firstSeenAt: string;
      lastSeenAt: string;
      writes: Write[];
    };

const when = (iso: string | null | undefined) => (iso ? `${new Date(iso).toLocaleString()} (${timeAgo(iso)})` : "—");

/**
 * Look a user up by your product's own id: the state YouGrow holds (what GET
 * /api/v2/users/{id} returns), the journeys they're in, their opt-outs and their
 * latest writes — so checking a test sign-up needs no API secret. `request` opens
 * one from the table.
 */
export function UserLookup({
  connectionId,
  steps,
  request,
}: {
  connectionId: string;
  steps: Array<{ id: string; label: string }>;
  request: { id: string; at: number } | null;
}) {
  const [draft, setDraft] = useState("");
  const [shown, setShown] = useState<{ id: string; result: Lookup } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  const lookup = useCallback(
    async (id: string) => {
      const userId = id.trim();
      if (!userId) return;
      setBusy(true);
      setError(null);
      const r = await api<Lookup>(`/api/admin/connections/${connectionId}/users/lookup?userId=${encodeURIComponent(userId)}`);
      setBusy(false);
      if (!r.ok) return setError(errorText(r.data));
      setShown({ id: userId, result: r.data });
    },
    [connectionId],
  );

  useEffect(() => {
    if (!request) return;
    setDraft(request.id);
    void lookup(request.id);
    top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [request, lookup]);

  function submit(e: FormEvent) {
    e.preventDefault();
    void lookup(draft);
  }

  return (
    <div ref={top} className="space-y-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <label className="min-w-[16rem] flex-1 space-y-1">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Look up a user by your user id</span>
          <input className={inputClass} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. the id your server sends" />
        </label>
        <Button type="submit" tone="primary" disabled={busy || !draft.trim()}>
          {busy ? "Looking…" : "Look up"}
        </Button>
        {shown ? <Button onClick={() => setShown(null)}>Close</Button> : null}
      </form>
      {error ? <Banner tone="err">{error}</Banner> : null}
      {shown ? <Result id={shown.id} result={shown.result} steps={steps} /> : null}
    </div>
  );
}

function Result({ id, result, steps }: { id: string; result: Lookup; steps: Array<{ id: string; label: string }> }) {
  if (!result.found) {
    return result.erasedAt ? (
      <Banner tone="info">
        Erased {when(result.erasedAt)}. For 30 days YouGrow keeps only a one-way hash of the ids and when they were erased.
      </Banner>
    ) : (
      <Banner tone="info">
        YouGrow doesn&apos;t hold a user with the id “{id}”: it was never sent, or was erased more than 30 days ago. Ids are
        case-sensitive.
      </Banner>
    );
  }
  const { user, writes } = result;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  const labels = new Map(steps.map((s) => [s.id, s.label]));
  const consent =
    user.consent && result.effectiveConsent && result.effectiveConsent !== user.consent
      ? `${user.consent} (counts as ${result.effectiveConsent} for this address)`
      : (user.consent ?? "—");

  return (
    <div className="space-y-4 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{name || user.email || user.userId}</span>
        <span className="font-mono text-neutral-500">{user.userId}</span>
        {user.excluded ? <Badge tone="red">excluded: {user.excluded.reason}</Badge> : null}
        {!user.subscribed ? <Badge tone="amber">opted out in your product</Badge> : null}
        {user.optOuts.length ? <Badge tone="amber">unsubscribed in our emails</Badge> : null}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <Row label="Signed up">{when(user.signedUpAt)}</Row>
        <Row label="Email">{user.email ?? "—"}</Row>
        <Row label="Name">{name || "—"}</Row>
        <Row label="Timezone">{user.timezone ?? "—"}</Row>
        <Row label="Locale">{user.locale ?? "—"}</Row>
        <Row label="Consent">{consent}</Row>
        <Row label="Subscribed">{user.subscribed ? "yes" : "no"}</Row>
        <Row label="Excluded">{user.excluded ? user.excluded.reason : "no"}</Row>
        <Row label="State as of">{when(user.updatedAt)}</Row>
        <Row label="First and last write">
          {when(result.firstSeenAt)} · {when(result.lastSeenAt)}
        </Row>
      </dl>

      <Block title="Onboarding steps, facts and traits">
        {Object.keys(user.steps).length + Object.keys(user.facts).length + Object.keys(user.traits).length === 0 ? (
          <p className="text-neutral-500">None sent yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {Object.entries(user.steps).map(([step, at]) => (
              <li key={`s:${step}`}>
                ✓ {labels.get(step) ?? step} <span className="text-neutral-500">{timeAgo(at)}</span>
              </li>
            ))}
            {Object.entries(user.facts).map(([k, v]) => (
              <li key={`f:${k}`} className="font-mono">
                fact.{k} = {JSON.stringify(v)}
              </li>
            ))}
            {Object.entries(user.traits).map(([k, v]) => (
              <li key={`t:${k}`} className="font-mono">
                trait.{k} = {JSON.stringify(v)}
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="Journeys">
        {user.enrolments.length === 0 ? (
          <p className="text-neutral-500">
            Not in any journey. A journey in test mode only takes the people on its test list, and a sign-up journey only
            takes people inside its window.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {user.enrolments.map((e) => (
              <li key={e.journeyId}>
                {e.journeyName ?? e.journeyId} · <Badge>{e.status}</Badge> <Badge>{e.mode}</Badge>{" "}
                <span className="text-neutral-500">joined {timeAgo(e.enrolledAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="Opt-outs made in our emails">
        {user.optOuts.length === 0 ? (
          <p className="text-neutral-500">None.</p>
        ) : (
          <ul className="space-y-0.5">
            {user.optOuts.map((o, i) => (
              <li key={i}>
                {o.scope === "all" ? "Every email" : `The ${o.category ?? "unknown"} emails`}{" "}
                <span className="text-neutral-500">{o.at ? timeAgo(o.at) : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title={`Latest writes (${writes.length})`}>
        {writes.length === 0 ? (
          <p className="text-neutral-500">None in the last 90 days.</p>
        ) : (
          <ul className="space-y-1">
            {writes.map((w, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-20 shrink-0 text-neutral-500">{timeAgo(w.at)}</span>
                <span className="shrink-0">{w.type === "track" ? <span className="font-mono">{w.event}</span> : <Badge>state update</Badge>}</span>
                <span className="shrink-0">{w.applied ? "✓" : `— ${(w.skipped ?? "not applied").replace(/_/g, " ")}`}</span>
                <span className="min-w-0 truncate font-mono text-neutral-500" title={JSON.stringify(w.payload)}>
                  {JSON.stringify(w.payload)}
                  {w.ignoredFields.length ? <span className="text-amber-700 dark:text-amber-400"> · ignored: {w.ignoredFields.join(", ")}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <h4 className="font-semibold text-neutral-700 dark:text-neutral-300">{title}</h4>
      {children}
    </div>
  );
}
