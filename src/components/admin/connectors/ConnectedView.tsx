"use client";

import { useEffect, useRef, useState, type Ref } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ConnectionView } from "@/lib/connectors/service";
import { connectedActions, revealManage, type ConnectedActions, type ConnectedNote } from "./connectedActions";
import { ConnectorTile } from "./ConnectorTile";
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
  COLLECTED_COPY,
  NOTE_SOFT,
  ORGANISATION_PATH,
  PART_COPY,
  accountWords,
  activityOf,
  bannerWords,
  collectedCell,
  collectedLines,
  endedNotesOf,
  firstSelected,
  fromWords,
  healthLine,
  listingPath,
  managedWords,
  manageHintOf,
  needsAttention,
  partRegionWords,
  pickPath,
  readingWords,
  readsWords,
  selectedOf,
  stateOf,
  whenWords,
  whoCanReadOf,
  whoWords,
} from "./words";

export interface ConnectedProps {
  connections: ConnectionView[];
  isAdmin: boolean;
  /** The signed in person, so activity can say "You". */
  uid: string;
  /** Vizzy reads connected data (CONNECTORS_CHAT_ENABLED): only then is the Vizzy grant offered. */
  chat: boolean;
  /** Collected numbers (CONNECTORS_COLLECT_ENABLED): the Collected column and the Manage card's block. */
  collect?: boolean;
  /** Collected numbers suggest articles: the Manage card says whether each is used for planning. */
  planning?: boolean;
  /** The connection to open on (`?c=<id>`, from a Review row), when it is listed. */
  selected?: string | null;
  /**
   * The person owns this brand's organisation and is an admin here (read live on the server, as the
   * Organisation tab is): a part that needs its organisation then offers Fix, to Settings › Organisation.
   */
  owner?: boolean;
  /** The server's clock when the page was drawn, so server and browser write the same times. */
  now: string;
}

const NOTE_CLASS = { ok: NOTE_OK, warn: NOTE_WARN, err: NOTE_ERR } as const;
const th = "border-b border-neutral-200 px-3 py-2 text-left text-xs font-medium text-neutral-500 dark:border-neutral-800 dark:text-neutral-400";
const td = "border-b border-neutral-100 px-3 py-2.5 align-top dark:border-neutral-900";

/**
 * Settings › Connections › Connected: the brand's connections with their health, a banner for
 * each one that needs something, and for admins the selected connection's grants, Check now,
 * Pause or Resume, Disconnect, and the recent activity. Every change goes through the routes under
 * /api/admin/connectors; members see names and states, read only.
 */
export function ConnectedView({ connections: initial, isAdmin, uid, chat, collect = false, planning = false, selected: wanted = null, owner = false, now: drawnAt }: ConnectedProps) {
  const router = useRouter();
  const [connections, setConnections] = useState(initial);
  // Chosen once, explicitly, then only by a click or an action: never worked out again from state.
  const [selectedId, setSelectedId] = useState<string | null>(() => firstSelected(initial, wanted));
  const [now, setNow] = useState(() => new Date(drawnAt));
  const [note, setNote] = useState<ConnectedNote>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Each row pick, counted, so the Manage card is brought into view after it is drawn.
  const [picks, setPicks] = useState(0);
  const manageRef = useRef<HTMLElement | null>(null);

  // A refresh from the server (router.refresh) brings the latest list; the selection stays.
  useEffect(() => setConnections(initial), [initial]);
  useEffect(() => {
    if (picks) revealManage(manageRef.current, window);
  }, [picks]);

  /** A row was picked, by a click anywhere on it or by its name's button from the keyboard. */
  const pick = (id: string) => {
    setSelectedId(id);
    setPicks((n) => n + 1);
  };

  const live = connections.filter((c) => c.status === "connected");
  const attention = needsAttention(live);
  const selected = selectedOf(live, selectedId);
  // Parts that ended because this brand left their organisation: they left the table, so say why.
  const endedNotes = endedNotesOf(connections, now).map((text) => (
    <p key={text} role="status" className={NOTE_SOFT}>
      {text}
    </p>
  ));

  const act = connectedActions({
    replace: (view) => {
      setConnections((list) => list.map((c) => (c.id === view.id ? view : c)));
      setNow(new Date());
      router.refresh();
    },
    select: setSelectedId,
    note: setNote,
    confirm: (message) => window.confirm(message),
    leave: (url) => window.location.assign(url),
    push: (path) => router.push(path),
    refresh: () => router.refresh(),
  });

  async function run(key: string, task: () => Promise<void>) {
    setBusy(key);
    setNote(null);
    try {
      await task();
    } finally {
      setBusy(null);
    }
  }

  const actions: ConnectedActions = {
    reconnect: (c) => run(`reconnect:${c.id}`, () => act.reconnect(c)),
    checkAccess: (c) => run(`access:${c.id}`, () => act.checkAccess(c)),
    check: (c) => run(`check:${c.id}`, () => act.check(c)),
    pause: (c, paused) => run(`pause:${c.id}`, () => act.pause(c, paused)),
    grant: (c, to, on) => run(`grant:${c.id}`, () => act.grant(c, to, on)),
    disconnect: (c) => run(`disconnect:${c.id}`, () => act.disconnect(c)),
  };

  if (!live.length && !note) {
    return (
      <div className="space-y-3">
        {endedNotes}
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
      {endedNotes}
      {attention.map((c) => (
        <AttentionBanner key={c.id} c={c} among={live} isAdmin={isAdmin} owner={owner} busy={busy} onReconnect={actions.reconnect} onCheckAccess={actions.checkAccess} />
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
                    {collect ? <th className={th}>{COLLECTED_COPY.column}</th> : null}
                  </>
                ) : (
                  <th className={th}>Reading</th>
                )}
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {live.map((c) => (
                <ConnectionRow key={c.id} c={c} isAdmin={isAdmin} on={isAdmin && selected?.id === c.id} uid={uid} chat={chat} collect={collect} now={now} onPick={pick} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {isAdmin ? (
        <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
          {selected ? (
            <ManageCard c={selected} chat={chat} collect={collect} planning={planning} now={now} busy={busy} actions={actions} cardRef={manageRef} />
          ) : live.length ? (
            <p className={NOTE_PLAIN}>{CONNECTED_COPY.chooseRow}</p>
          ) : null}
          <ActivityCard connections={connections} uid={uid} now={now} />
        </div>
      ) : null}
    </div>
  );
}

/** Room above the Manage card when a pick scrolls to it: the sticky admin header is 48px (h-12), as ReviewHub allows. */
export const MANAGE_SCROLL_MARGIN = "scroll-mt-16";

/** A connection's small tile, beside its name: the connector's mark, or its two letters. */
function Tile({ c }: { c: ConnectionView }) {
  return <ConnectorTile id={c.connectorId} name={c.connectorName} initials={c.connectorInitials} icon={c.connectorIcon} size="sm" />;
}

/**
 * A row's classes: admins can pick any row; the picked one gets a tint and an accent bar, in light
 * and dark. The tint is a clear blue in both themes, so it stands apart from a plain row and from
 * the grey of a hovered one.
 */
export const ROW_CLASS = {
  pickable: "cursor-pointer transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900/60",
  picked: "cursor-pointer bg-blue-100/70 transition-colors dark:bg-blue-900/40",
  /** On the first cell: box-shadow, so the bar takes no width and the columns stay where they are. */
  bar: "shadow-[inset_3px_0_0_#2563eb] dark:shadow-[inset_3px_0_0_#3b82f6]",
} as const;

/**
 * One connection's row. For an admin the whole row picks the connection: a click anywhere on it,
 * or Enter or Space on its name's button, which is how the keyboard reaches it. The button has no
 * handler of its own, so its click reaches the row once; any other button or link a row holds does
 * its own job and the same click picks its row. No hooks, so a test can draw it as a plain function.
 */
/** A thin bar for days collected out of the days kept. */
export function CollectBar({ value, max }: { value: number; max: number }) {
  const width = `${Math.max(0, Math.min(100, (value / max) * 100)).toFixed(1)}%`;
  return (
    <span
      role="progressbar"
      aria-label={COLLECTED_COPY.progress}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="mb-0.5 mt-1.5 block h-1 w-full max-w-[160px] overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
    >
      <span className="block h-full rounded-full bg-blue-600 dark:bg-blue-400" style={{ width }} />
    </span>
  );
}

export function ConnectionRow({
  c,
  isAdmin,
  on,
  uid,
  chat,
  collect = false,
  now,
  onPick,
}: {
  c: ConnectionView;
  isAdmin: boolean;
  /** The picked row (admins only). */
  on: boolean;
  uid: string;
  chat: boolean;
  /** Collected numbers are on: admins see the Collected column, members how far it is collected. */
  collect?: boolean;
  now: Date;
  onPick: (id: string) => void;
}) {
  const state = stateOf(c);
  const last = c.details?.recent[0];
  const cell = collect ? collectedCell(c) : null;
  return (
    <tr
      className={isAdmin ? (on ? ROW_CLASS.picked : ROW_CLASS.pickable) : undefined}
      aria-selected={isAdmin ? on : undefined}
      onClick={isAdmin ? () => onPick(c.id) : undefined}
    >
      <td className={on ? `${td} ${ROW_CLASS.bar}` : td}>
        <span className="flex items-start gap-2.5">
          <Tile c={c} />
          <span className="min-w-0">
            {isAdmin ? (
              <button type="button" className={on ? "text-left font-medium text-blue-900 hover:underline dark:text-blue-100" : "text-left font-medium hover:underline"} aria-pressed={on}>
                {c.connectorName}
              </button>
            ) : (
              <span className="font-medium">{c.connectorName}</span>
            )}
            {c.label !== c.connectorName ? <span className={`block ${HINT}`}>{c.label}</span> : null}
            {c.details ? <span className={`block ${HINT}`}>{accountWords(c.details.account)}</span> : null}
          </span>
        </span>
      </td>
      {isAdmin && c.details ? (
        <>
          <td className={td}>{c.part ? fromWords(c.part.organisation) : HOW_LABELS[c.details.method]}</td>
          <td className={td}>{c.details.ownerUid === uid ? "You" : "Someone else"}</td>
          <td className={td}>{last ? `${whoWords(last.by, uid)} · ${whenWords(last.at, now)}` : ""}</td>
          <td className={td}>{whoCanReadOf(c, chat)}</td>
          {collect ? (
            <td className={td}>
              {cell ? (
                <>
                  <span className="block">{cell.main}</span>
                  {cell.progress ? <CollectBar value={cell.progress.value} max={cell.progress.max} /> : null}
                  {cell.hint ? <span className={`block ${HINT}`}>{cell.hint}</span> : null}
                </>
              ) : null}
            </td>
          ) : null}
        </>
      ) : isAdmin ? (
        <td className={td} colSpan={collect ? 5 : 4} />
      ) : (
        <td className={td}>{readingWords(c, collect)}</td>
      )}
      <td className={td}>
        <span className={`${TAG} ${TONE_CLASS[state.tone]}`}>{state.label}</span>
      </td>
    </tr>
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

/**
 * A banner for a connection that needs something, with the way to fix it. A brand's part is fixed
 * by its organisation's owners, never here: its words say so, an owner gets Fix (to Settings ›
 * Organisation) and everyone else nothing to press, never Reconnect or Sign in again.
 */
export function AttentionBanner({
  c,
  among,
  isAdmin,
  owner = false,
  busy,
  onReconnect,
  onCheckAccess,
}: {
  c: ConnectionView;
  /** The connections shown, so a banner says which one when two connect to the same tool. */
  among: readonly ConnectionView[];
  isAdmin: boolean;
  /** An owner of this brand's organisation who is an admin here. */
  owner?: boolean;
  busy: string | null;
  onReconnect: (c: ConnectionView) => void;
  onCheckAccess: (c: ConnectionView) => void;
}) {
  const words = bannerWords(c, among);
  const fix =
    owner && isAdmin ? (
      <Link href={ORGANISATION_PATH} className={BUTTON_PRIMARY}>
        {PART_COPY.fix}
      </Link>
    ) : null;
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950/40">
      <p className="text-sm text-amber-900 dark:text-amber-200">
        {words}
        {!isAdmin && !c.part ? ` ${CONNECTED_COPY.askAdmin}` : ""}
      </p>
      {c.part ? fix : isAdmin ? <ReconnectAction c={c} busy={busy} onReconnect={onReconnect} onCheckAccess={onCheckAccess} /> : null}
    </div>
  );
}

function ManageCard({
  c,
  chat,
  collect,
  planning,
  now,
  busy,
  actions,
  cardRef,
}: {
  c: ConnectionView;
  chat: boolean;
  collect: boolean;
  planning: boolean;
  now: Date;
  busy: string | null;
  /** So a row pick on a narrow screen can bring the card into view. */
  cardRef?: Ref<HTMLElement>;
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
  // A brand's part has no Google address, no Check access, no picker and no Sign in again here: its
  // organisation's owners manage all of that. With sharing off it reads nothing, so offers nothing.
  const part = c.part ?? null;
  const acts = !part || part.reads !== "off";
  // Its own pause: a part its organisation's owners paused shows Paused too, but only they resume it.
  const paused = Boolean(c.details?.pausedAt) || (c.health.state === "paused" && part?.reads !== "paused");
  const state = stateOf(c);
  const line = healthLine(c, now);
  const sa = !part && c.details?.method === "share_access" && c.details.serviceAccount && !c.details.serviceAccount.deletedAt ? c.details.serviceAccount.email : null;
  const picks = !part && (c.details?.method === "oauth_pkce" || c.details?.method === "share_access");
  const any = busy !== null;
  const lines = collect && acts ? collectedLines(c, { planning, chat }) : [];
  const region = part ? partRegionWords(c) : null;

  return (
    // scroll-mt-16 clears the admin header (sticky, 48px), so a pick on a narrow screen shows the card's heading.
    <section ref={cardRef} aria-labelledby="manage-title" className={`${CARD} ${MANAGE_SCROLL_MARGIN} space-y-3`}>
      <h3 id="manage-title" className="flex items-center gap-2 text-sm font-semibold">
        <Tile c={c} />
        <span>
          {c.connectorName} · {readsWords(c) || accountWords("")}
        </span>
      </h3>
      <p className="text-sm">
        <span className={`${TAG} ${TONE_CLASS[state.tone]}`}>{state.label}</span>
        {line ? <span className={`ml-2 ${HINT}`}>{line}</span> : null}
      </p>
      {part ? (
        <div className="space-y-1">
          <p role="note" className={NOTE_SOFT}>
            {managedWords(part.organisation)}
          </p>
          {region ? <p className={HINT}>{region}</p> : null}
        </div>
      ) : null}
      {c.connectorOn && acts ? (
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
      {lines.length ? (
        <div className="space-y-1.5 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <h4 className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{COLLECTED_COPY.block}</h4>
          {lines.map((l) => (
            <div key={`${l.lead ?? ""}${l.text}`}>
              <p className={l.hint ? HINT : "text-sm"}>
                {l.lead ? <span className="font-semibold">{l.lead}</span> : null}
                {l.text}
              </p>
              {l.progress ? <CollectBar value={l.progress.value} max={l.progress.max} /> : null}
            </div>
          ))}
        </div>
      ) : null}
      {sa ? (
        <div className="space-y-1">
          <p className={HINT}>{CONNECTED_COPY.address}</p>
          <code className="block break-all rounded-md border border-neutral-300 bg-neutral-50 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900">{sa}</code>
        </div>
      ) : null}
      {acts ? (
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
          {!part ? (
            <button
              type="button"
              className={`${BUTTON} border-red-300 text-red-700 dark:border-red-900 dark:text-red-400`}
              disabled={any}
              onClick={() => actions.disconnect(c)}
            >
              {busy === `disconnect:${c.id}` ? "Disconnecting…" : CONNECTED_COPY.disconnect}
            </button>
          ) : null}
        </div>
      ) : null}
      {!part ? <p className={HINT}>{manageHintOf(c, { collect, planning })}</p> : null}
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
