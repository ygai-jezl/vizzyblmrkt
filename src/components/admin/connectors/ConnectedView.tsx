"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ConnectionView } from "@/lib/connectors/service";
import { callApi, ROUTES, startSignIn } from "./api";
import {
  BUTTON,
  BUTTON_PRIMARY,
  CARD,
  CONNECTED_COPY,
  HINT,
  HOW_LABELS,
  NOTE_ERR,
  NOTE_OK,
  NOTE_PLAIN,
  NOTE_WARN,
  SCREEN_COPY,
  TAG,
  TONE_CLASS,
  accountWords,
  activityOf,
  healthLine,
  listingPath,
  needsAttention,
  pickPath,
  stateOf,
  whenWords,
  whoCanReadOf,
  whoWords,
  withGrant,
} from "./words";

export interface ConnectedProps {
  connections: ConnectionView[];
  isAdmin: boolean;
  /** The signed in person, so activity can say "You". */
  uid: string;
  /** Vizzy reads connected data (CONNECTORS_CHAT_ENABLED): only then is the Vizzy grant offered. */
  chat: boolean;
  /** The server's clock when the page was drawn, so server and browser write the same times. */
  now: string;
}

type Note = { tone: "ok" | "warn" | "err"; text: string } | null;
const NOTE_CLASS = { ok: NOTE_OK, warn: NOTE_WARN, err: NOTE_ERR } as const;
const th = "border-b border-neutral-200 px-3 py-2 text-left text-xs font-medium text-neutral-500 dark:border-neutral-800 dark:text-neutral-400";
const td = "border-b border-neutral-100 px-3 py-2.5 align-top dark:border-neutral-900";

/**
 * Settings › Connections › Connected: the brand's connections with their health, a banner for
 * each one that needs something, and for admins the selected connection's grants, Check now,
 * Pause or Resume, Disconnect, and the recent activity. Every change goes through the routes under
 * /api/admin/connectors; members see names and states, read only.
 */
export function ConnectedView({ connections: initial, isAdmin, uid, chat, now: drawnAt }: ConnectedProps) {
  const router = useRouter();
  const [connections, setConnections] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date(drawnAt));
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // A refresh from the server (router.refresh) brings the latest list.
  useEffect(() => setConnections(initial), [initial]);

  const live = connections.filter((c) => c.status === "connected");
  const attention = needsAttention(live);
  const selected = live.find((c) => c.id === selectedId) ?? attention[0] ?? live[0] ?? null;

  function replace(view: ConnectionView) {
    setConnections((list) => list.map((c) => (c.id === view.id ? view : c)));
    setNow(new Date());
    router.refresh();
  }

  async function run(key: string, task: () => Promise<void>) {
    setBusy(key);
    setNote(null);
    try {
      await task();
    } finally {
      setBusy(null);
    }
  }

  const actions = {
    reconnect: (c: ConnectionView) =>
      run(`reconnect:${c.id}`, async () => {
        const r = await startSignIn(c.connectorId, c.id);
        if (r.ok) window.location.assign(r.data.url);
        else setNote({ tone: "err", text: r.message });
      }),
    checkAccess: (c: ConnectionView) =>
      run(`access:${c.id}`, async () => {
        const r = await callApi<{ connection: ConnectionView; visible: boolean; message: string | null }>(ROUTES.access(c.id), { method: "POST" });
        if (!r.ok) return setNote({ tone: r.status === 409 ? "warn" : "err", text: r.message });
        replace(r.data.connection);
        if (r.data.visible && r.data.connection.needsAccount) router.push(pickPath(c.connectorId, c.id));
        else setNote(r.data.visible ? { tone: "ok", text: CONNECTED_COPY.checkedOk } : { tone: "warn", text: r.data.message ?? CONNECTED_COPY.checkedOk });
      }),
    check: (c: ConnectionView) =>
      run(`check:${c.id}`, async () => {
        const r = await callApi<{ connection: ConnectionView; check: { ok: boolean; message: string | null } }>(ROUTES.check(c.id), { method: "POST" });
        if (!r.ok) return setNote({ tone: r.status === 409 ? "warn" : "err", text: r.message });
        replace(r.data.connection);
        setNote(r.data.check.ok ? { tone: "ok", text: CONNECTED_COPY.checkedOk } : { tone: "warn", text: r.data.check.message ?? CONNECTED_COPY.checkedOk });
      }),
    pause: (c: ConnectionView, paused: boolean) =>
      run(`pause:${c.id}`, async () => {
        const r = await callApi<ConnectionView>(ROUTES.pause(c.id), { method: "POST", body: { paused } });
        if (!r.ok) return setNote({ tone: "err", text: r.message });
        replace(r.data);
      }),
    grant: (c: ConnectionView, to: "members" | "agent:vizzy", on: boolean) =>
      run(`grant:${c.id}`, async () => {
        const r = await callApi<ConnectionView>(ROUTES.grants(c.id), { method: "PUT", body: { grants: withGrant(c.details?.grants ?? [], to, on) } });
        if (!r.ok) return setNote({ tone: "err", text: r.message });
        replace(r.data);
      }),
    disconnect: (c: ConnectionView) =>
      run(`disconnect:${c.id}`, async () => {
        if (!window.confirm(CONNECTED_COPY.confirmDisconnect)) return;
        const r = await callApi<{ connection: ConnectionView; message: string }>(ROUTES.connection(c.id), { method: "DELETE" });
        if (!r.ok) return setNote({ tone: "err", text: r.message });
        replace(r.data.connection);
        setSelectedId(null);
        setNote({ tone: "ok", text: r.data.message });
      }),
  };

  if (!live.length && !note) {
    return (
      <div className="space-y-3">
        <p className={NOTE_PLAIN}>
          {CONNECTED_COPY.none}{" "}
          <Link href="/admin/account/connections/browse" className="font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">
            Browse
          </Link>
        </p>
        {isAdmin ? <ActivityCard connections={connections} uid={uid} now={now} /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {note ? (
        <p role={note.tone === "err" ? "alert" : "status"} className={NOTE_CLASS[note.tone]}>
          {note.text}
        </p>
      ) : null}
      {attention.map((c) => (
        <AttentionBanner key={c.id} c={c} isAdmin={isAdmin} busy={busy} onReconnect={actions.reconnect} onCheckAccess={actions.checkAccess} />
      ))}
      {!isAdmin ? <p className={HINT}>{SCREEN_COPY.membersOnly}</p> : null}

      {live.length ? (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={th}>Connection</th>
                {isAdmin ? (
                  <>
                    <th className={th}>How</th>
                    <th className={th}>Connected by</th>
                    <th className={th}>Last activity</th>
                    <th className={th}>Who can read</th>
                  </>
                ) : (
                  <th className={th}>Reading</th>
                )}
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {live.map((c) => {
                const state = stateOf(c);
                const last = c.details?.recent[0];
                const on = isAdmin && selected?.id === c.id;
                return (
                  <tr key={c.id} className={on ? "bg-neutral-50 dark:bg-neutral-900/60" : undefined}>
                    <td className={td}>
                      {isAdmin ? (
                        <button type="button" className="text-left font-medium hover:underline" aria-pressed={on} onClick={() => setSelectedId(c.id)}>
                          {c.connectorName}
                        </button>
                      ) : (
                        <span className="font-medium">{c.connectorName}</span>
                      )}
                      {c.label !== c.connectorName ? <span className={`block ${HINT}`}>{c.label}</span> : null}
                      {c.details ? <span className={`block ${HINT}`}>{accountWords(c.details.account)}</span> : null}
                    </td>
                    {isAdmin && c.details ? (
                      <>
                        <td className={td}>{HOW_LABELS[c.details.method]}</td>
                        <td className={td}>{c.details.ownerUid === uid ? "You" : "Someone else"}</td>
                        <td className={td}>{last ? `${whoWords(last.by, uid)} · ${whenWords(last.at, now)}` : ""}</td>
                        <td className={td}>{whoCanReadOf(c, chat)}</td>
                      </>
                    ) : isAdmin ? (
                      <td className={td} colSpan={4} />
                    ) : (
                      <td className={td}>{c.canReadLive ? CONNECTED_COPY.readsYou : CONNECTED_COPY.readsAdmins}</td>
                    )}
                    <td className={td}>
                      <span className={`${TAG} ${TONE_CLASS[state.tone]}`}>{state.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {isAdmin ? (
        <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
          {selected ? <ManageCard c={selected} chat={chat} now={now} busy={busy} actions={actions} /> : null}
          <ActivityCard connections={connections} uid={uid} now={now} />
        </div>
      ) : null}
    </div>
  );
}

function ReconnectAction({ c, busy, onReconnect, onCheckAccess }: { c: ConnectionView; busy: string | null; onReconnect: (c: ConnectionView) => void; onCheckAccess: (c: ConnectionView) => void }) {
  if (c.needsAccount) {
    return (
      <Link href={pickPath(c.connectorId, c.id)} className={BUTTON_PRIMARY}>
        Choose a property
      </Link>
    );
  }
  const method = c.details?.method;
  if (method === "oauth_pkce") {
    return (
      <button type="button" className={BUTTON_PRIMARY} disabled={busy !== null} onClick={() => onReconnect(c)}>
        {busy === `reconnect:${c.id}` ? "Opening Google…" : CONNECTED_COPY.reconnect}
      </button>
    );
  }
  if (method === "share_access") {
    return (
      <button type="button" className={BUTTON_PRIMARY} disabled={busy !== null} onClick={() => onCheckAccess(c)}>
        {busy === `access:${c.id}` ? "Checking…" : "Check access"}
      </button>
    );
  }
  return (
    <Link href={`${listingPath(c.connectorId)}?reconnect=${encodeURIComponent(c.id)}`} className={BUTTON_PRIMARY}>
      {CONNECTED_COPY.reconnect}
    </Link>
  );
}

function AttentionBanner({
  c,
  isAdmin,
  busy,
  onReconnect,
  onCheckAccess,
}: {
  c: ConnectionView;
  isAdmin: boolean;
  busy: string | null;
  onReconnect: (c: ConnectionView) => void;
  onCheckAccess: (c: ConnectionView) => void;
}) {
  const words = c.needsAccount ? `${c.connectorName} is connected, but reads nothing until a property is chosen.` : `${c.connectorName}: ${c.health.message ?? "it needs connecting again."}`;
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950/40">
      <p className="text-sm text-amber-900 dark:text-amber-200">
        {words}
        {!isAdmin ? ` ${CONNECTED_COPY.askAdmin}` : ""}
      </p>
      {isAdmin ? <ReconnectAction c={c} busy={busy} onReconnect={onReconnect} onCheckAccess={onCheckAccess} /> : null}
    </div>
  );
}

function ManageCard({
  c,
  chat,
  now,
  busy,
  actions,
}: {
  c: ConnectionView;
  chat: boolean;
  now: Date;
  busy: string | null;
  actions: {
    check: (c: ConnectionView) => void;
    checkAccess: (c: ConnectionView) => void;
    pause: (c: ConnectionView, paused: boolean) => void;
    grant: (c: ConnectionView, to: "members" | "agent:vizzy", on: boolean) => void;
    disconnect: (c: ConnectionView) => void;
  };
}) {
  const grants = c.details?.grants ?? [];
  const has = (to: "members" | "agent:vizzy") => grants.some((g) => g.to === to);
  const paused = Boolean(c.details?.pausedAt) || c.health.state === "paused";
  const state = stateOf(c);
  const line = healthLine(c, now);
  const sa = c.details?.method === "share_access" && c.details.serviceAccount && !c.details.serviceAccount.deletedAt ? c.details.serviceAccount.email : null;
  const picks = c.details?.method === "oauth_pkce" || c.details?.method === "share_access";
  const any = busy !== null;

  return (
    <section aria-labelledby="manage-title" className={`${CARD} space-y-3`}>
      <h3 id="manage-title" className="text-sm font-semibold">
        {c.connectorName} · {accountWords(c.details?.account ?? "")}
      </h3>
      <p className="text-sm">
        <span className={`${TAG} ${TONE_CLASS[state.tone]}`}>{state.label}</span>
        {line ? <span className={`ml-2 ${HINT}`}>{line}</span> : null}
      </p>
      {c.connectorOn ? (
        <fieldset className="space-y-2" disabled={any}>
          <legend className={HINT}>{CONNECTED_COPY.grantsLead}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={has("members")} onChange={(e) => actions.grant(c, "members", e.target.checked)} />
            {CONNECTED_COPY.members}
          </label>
          {chat ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={has("agent:vizzy")} onChange={(e) => actions.grant(c, "agent:vizzy", e.target.checked)} />
              {CONNECTED_COPY.vizzy}
            </label>
          ) : null}
        </fieldset>
      ) : null}
      {sa ? (
        <div className="space-y-1">
          <p className={HINT}>{CONNECTED_COPY.address}</p>
          <code className="block break-all rounded-md border border-neutral-300 bg-neutral-50 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900">{sa}</code>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {c.connectorOn ? (
          <>
            {sa ? (
              <button type="button" className={BUTTON} disabled={any} onClick={() => actions.checkAccess(c)}>
                {busy === `access:${c.id}` ? "Checking…" : "Check access"}
              </button>
            ) : null}
            {!c.needsAccount ? (
              <button type="button" className={BUTTON} disabled={any || paused} onClick={() => actions.check(c)}>
                {busy === `check:${c.id}` ? "Checking…" : CONNECTED_COPY.checkNow}
              </button>
            ) : null}
            <button type="button" className={BUTTON} disabled={any} onClick={() => actions.pause(c, !paused)}>
              {paused ? CONNECTED_COPY.resume : CONNECTED_COPY.pause}
            </button>
            {picks ? (
              <Link href={pickPath(c.connectorId, c.id)} className={BUTTON}>
                {c.needsAccount ? "Choose a property" : "Change property"}
              </Link>
            ) : null}
          </>
        ) : null}
        <button
          type="button"
          className={`${BUTTON} border-red-300 text-red-700 dark:border-red-900 dark:text-red-400`}
          disabled={any}
          onClick={() => actions.disconnect(c)}
        >
          {busy === `disconnect:${c.id}` ? "Disconnecting…" : CONNECTED_COPY.disconnect}
        </button>
      </div>
      <p className={HINT}>{CONNECTED_COPY.manageHint}</p>
    </section>
  );
}

function ActivityCard({ connections, uid, now }: { connections: ConnectionView[]; uid: string; now: Date }) {
  const rows = activityOf(connections);
  return (
    <section aria-labelledby="activity-title" className={`${CARD} space-y-3`}>
      <h3 id="activity-title" className="text-sm font-semibold">
        {CONNECTED_COPY.activity}
      </h3>
      {rows.length ? (
        <ul className="space-y-2.5 text-sm">
          {rows.map((r) => (
            <li key={r.key}>
              <span className="block">{r.text}</span>
              <span className={HINT}>
                {r.by === "operator" ? "Whoever runs YouGrow" : whoWords(r.by, uid)} · {whenWords(r.at, now)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={HINT}>{CONNECTED_COPY.noActivity}</p>
      )}
      <p className={HINT}>{CONNECTED_COPY.activityKept}</p>
    </section>
  );
}
