"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HowToLink } from "@/components/help/HowToLink";
import type { SharedConnectionsScreen, SharedConnectionView } from "@/lib/connectors/organisationConnect";
import { dayWords } from "@/lib/connectors/period";
import { callApi, ORG_ROUTES, startOrganisationSignIn } from "./api";
import { CollectBar } from "./ConnectedView";
import { ConnectorTile } from "./ConnectorTile";
import { ConnectionAbout, DialogFrame, GivePartDialog } from "./GivePartDialog";
import {
  BUTTON,
  BUTTON_PRIMARY,
  CARD,
  GIVE_COPY,
  HINT,
  NOTE_ERR,
  NOTE_OK,
  NOTE_PLAIN,
  NOTE_WARN,
  REVOKE_WARNING,
  SHARED_COPY,
  SHARED_HELP_PATH,
  TAG,
  TONE_CLASS,
  afterSignInWords,
  cantReadCountWords,
  connectedForWords,
  signInReasonWords,
  disconnectTextWords,
  disconnectTitleWords,
  everyBrandHasPart,
  everyBrandHasWords,
  giveTitleWords,
  noPartsWords,
  partCollectedWords,
  partReadersWords,
  partUnit,
  partUnreadable,
  partWords,
  productWords,
  sharedHowWords,
  sharedNotesOf,
  sharedStateOf,
  signInAgainTextWords,
  signInAgainTitleWords,
  signedInAgainWords,
  stoppedUsingWords,
  takeBackTextWords,
  takeBackTitleWords,
  whoseWords,
} from "./words";

const DANGER = `${BUTTON} border-red-300 text-red-700 dark:border-red-900 dark:text-red-400`;
const SMALL = "px-2 py-1 text-xs";
const TH = "border-b border-neutral-200 px-3 py-2 text-left text-xs font-medium text-neutral-500 dark:border-neutral-800 dark:text-neutral-400";
const TD = "border-b border-neutral-100 px-3 py-2 align-top last:border-b-0 dark:border-neutral-900";
const NOTE_CLASS = { plain: "rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300", hint: `${HINT} px-0.5`, warn: NOTE_WARN } as const;

/** What a card's buttons do, so a test can draw a card with no handlers wired. */
export interface CardActions {
  give: (c: SharedConnectionView) => void;
  change: (c: SharedConnectionView, tenantId: string) => void;
  takeBack: (c: SharedConnectionView, tenantId: string) => void;
  pause: (c: SharedConnectionView, paused: boolean) => void;
  signInAgain: (c: SharedConnectionView) => void;
  disconnect: (c: SharedConnectionView) => void;
  copy: (c: SharedConnectionView) => void;
}

/**
 * One organisation connection's card, as the approved Shared connections screen draws it: how it
 * signs in and where it is kept, its state, its notes, its Google address, and who gets which part.
 * No hooks, so a test can draw it as a plain function.
 */
export function SharedCard({
  c,
  screen,
  now,
  actions,
  busy,
  copied,
  after,
}: {
  c: SharedConnectionView;
  screen: SharedConnectionsScreen;
  now: Date;
  actions: CardActions;
  busy: boolean;
  copied: boolean;
  /** A line about the last change made here, such as the address that can still read a part. */
  after: string | null;
}) {
  const org = screen.organisation.name;
  const unit = partUnit(c.connectorId);
  const state = sharedStateOf(c);
  const notes = sharedNotesOf(c, now);
  const cant = c.parts.filter(partUnreadable).length;
  const allHave = everyBrandHasPart(c, screen.brands);
  const giveOff = busy || !c.mine || c.health.state === "broken" || !c.connectorOn;
  const hid = `org-conn-${c.id}`;
  return (
    <section aria-labelledby={hid} className={`${CARD} space-y-3`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <ConnectorTile id={c.connectorId} name={c.connectorName} initials={c.connectorInitials} icon={c.connectorIcon} size="sm" />
          <div className="min-w-0 space-y-1">
            <h3 id={hid} className="text-sm">
              <span className="font-semibold">{productWords(c.connectorName)}</span>
              {sharedHowWords(c, org)}
            </h3>
            <p className="flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <span>{`Kept in ${c.regionName}.`}</span>
              <span className={`${TAG} ${TONE_CLASS[state.tone]}`}>{state.label}</span>
              {cant ? <span className={`${TAG} ${TONE_CLASS.warn}`}>{cantReadCountWords(cant)}</span> : null}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {allHave ? (
            <p className={HINT}>{everyBrandHasWords(unit.one, c.method)}</p>
          ) : (
            <button type="button" className={BUTTON_PRIMARY} disabled={giveOff} onClick={() => actions.give(c)}>
              {giveTitleWords(unit.one)}
            </button>
          )}
          <button type="button" className={BUTTON} disabled={busy} onClick={() => actions.pause(c, !c.pausedAt)}>
            {c.pausedAt ? SHARED_COPY.resume : SHARED_COPY.pause}
          </button>
          {c.method === "oauth_pkce" ? (
            <button type="button" className={c.signer === "gone" || c.health.state === "broken" ? BUTTON_PRIMARY : BUTTON} disabled={busy} onClick={() => actions.signInAgain(c)}>
              {SHARED_COPY.signInAgain}
            </button>
          ) : null}
          <button type="button" className={DANGER} disabled={busy} onClick={() => actions.disconnect(c)}>
            {SHARED_COPY.disconnect}
          </button>
        </div>
      </div>

      {notes.map((n) => (
        <p key={n.text} role={n.tone === "warn" ? "status" : undefined} className={NOTE_CLASS[n.tone]}>
          {n.text}
        </p>
      ))}

      {c.serviceAccount ? (
        <div className="space-y-1">
          <p className={HINT}>{SHARED_COPY.address}</p>
          <span className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded-md border border-neutral-300 bg-neutral-50 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900">{c.serviceAccount.email}</code>
            <button type="button" className={BUTTON} onClick={() => actions.copy(c)}>
              {copied ? SHARED_COPY.copied : SHARED_COPY.copy}
            </button>
          </span>
        </div>
      ) : null}

      {c.parts.length ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table aria-label={`${productWords(c.connectorName)} parts`} className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={TH}>{SHARED_COPY.part}</th>
                <th className={TH}>{SHARED_COPY.givenTo}</th>
                <th className={TH}>{SHARED_COPY.since}</th>
                {screen.collect ? <th className={TH}>{SHARED_COPY.collected}</th> : null}
                <th className={TH}>{SHARED_COPY.readers}</th>
                <th className={TH}>
                  <span className="sr-only">{SHARED_COPY.actions}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {c.parts.map((p) => {
                const col = partCollectedWords(p, c);
                return (
                  <tr key={p.tenantId}>
                    <td className={`${TD} break-all font-medium`}>{partWords(p.account, p.record?.label)}</td>
                    <td className={TD}>
                      <span className="block">{p.brandName}</span>
                      {p.region !== c.region ? <span className={`block ${HINT}`}>{p.regionName}</span> : null}
                    </td>
                    {/* Since the part it reads now: a change dates it from the change (stateSince, set when a give or change goes active). */}
                    <td className={TD}>{dayWords((p.state === "active" ? p.stateSince : p.givenAt).slice(0, 10))}</td>
                    {screen.collect ? (
                      <td className={TD}>
                        <span className={`block ${col.warn ? "text-amber-700 dark:text-amber-400" : ""}`}>{col.main}</span>
                        {col.progress ? <CollectBar value={col.progress.value} max={col.progress.max} /> : null}
                        {col.hint ? <span className={`block ${HINT}`}>{col.hint}</span> : null}
                      </td>
                    ) : null}
                    <td className={TD}>{partReadersWords(p, screen.chat)}</td>
                    <td className={`${TD} whitespace-nowrap text-right`}>
                      <span className="inline-flex gap-2">
                        <button
                          type="button"
                          className={`${BUTTON} ${SMALL}`}
                          disabled={busy || !c.mine || p.state !== "active" || c.health.state === "broken" || !screen.brands.some((b) => b.id === p.tenantId)}
                          aria-label={`Change ${whoseWords(p.brandName)} ${unit.one}`}
                          onClick={() => actions.change(c, p.tenantId)}
                        >
                          {SHARED_COPY.change}
                        </button>
                        <button type="button" className={`${BUTTON} ${SMALL}`} disabled={busy || p.state === "ending"} aria-label={`Take back from ${p.brandName}`} onClick={() => actions.takeBack(c, p.tenantId)}>
                          {SHARED_COPY.takeBack}
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : !c.hadParts ? (
        <p className={HINT}>{noPartsWords(unit.one)}</p>
      ) : null}

      {after ? <p className={HINT}>{after}</p> : null}
      {c.stoppedUsing ? <p className={HINT}>{stoppedUsingWords(c.stoppedUsing.brandName, dayWords(c.stoppedUsing.at.slice(0, 10)))}</p> : null}
      {!c.parts.length && c.hadParts ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          <p>{SHARED_COPY.lastGone}</p>
          <button type="button" className={DANGER} disabled={busy} onClick={() => actions.disconnect(c)}>
            {SHARED_COPY.disconnect}
          </button>
        </div>
      ) : null}
    </section>
  );
}

type Open =
  | { kind: "give"; c: SharedConnectionView }
  | { kind: "change"; c: SharedConnectionView; tenantId: string }
  | { kind: "take"; c: SharedConnectionView; tenantId: string }
  | { kind: "signin"; c: SharedConnectionView }
  | { kind: "after"; c: SharedConnectionView }
  | { kind: "disconnect"; c: SharedConnectionView };

export interface SharedConnectionsProps {
  screen: SharedConnectionsScreen;
  /** What a connect or sign in for the organisation came back with (the page's query); `reason` when it failed. */
  back: { status: string | null; connection: string | null; reason?: string | null };
  /** The server's time, so holds and dates read the same in the browser. */
  now: string;
}

/**
 * Settings › Organisation › Shared connections (Connectors 3, owners only): the organisation's
 * connections from every region, each with who gets which part, and the dialogs that give, change
 * and take back a part, sign in again and disconnect. Every change goes through the routes under
 * /api/admin/organisation, which check the owner, the brand and the part again.
 */
export function SharedConnectionsView({ screen, back, now }: SharedConnectionsProps) {
  const router = useRouter();
  const at = new Date(now);
  const org = screen.organisation.name;
  const returned = back.connection ? screen.connections.find((c) => c.id === back.connection) ?? null : null;
  const [open, setOpen] = useState<Open | null>(back.status === "signed_in_again" && returned ? { kind: "after", c: returned } : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(
    back.status === "connected" ? { tone: "ok", text: connectedForWords(org) } : back.status === "error" ? { tone: "err", text: signInReasonWords(back.reason) } : null,
  );
  const [afters, setAfters] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const close = () => {
    setOpen(null);
    setError(null);
  };
  const done = (msg?: { tone: "ok" | "err"; text: string } | null) => {
    setOpen(null);
    setError(null);
    if (msg !== undefined) setNote(msg);
    router.refresh();
  };

  const actions: CardActions = {
    give: (c) => setOpen({ kind: "give", c }),
    change: (c, tenantId) => setOpen({ kind: "change", c, tenantId }),
    takeBack: (c, tenantId) => setOpen({ kind: "take", c, tenantId }),
    signInAgain: (c) => setOpen({ kind: "signin", c }),
    disconnect: (c) => setOpen({ kind: "disconnect", c }),
    pause: async (c, paused) => {
      setBusy(c.id);
      const r = await callApi(ORG_ROUTES.pause(c.id), { method: "POST", body: { paused } });
      setBusy(null);
      done(r.ok ? null : { tone: "err", text: r.message });
    },
    copy: async (c) => {
      if (!c.serviceAccount) return;
      try {
        await navigator.clipboard.writeText(c.serviceAccount.email);
        setCopied(c.id);
        window.setTimeout(() => setCopied(null), 2000);
      } catch {
        // No clipboard here: the address is on screen to select.
      }
    },
  };

  async function confirm() {
    if (!open) return;
    const c = open.c;
    setBusy(c.id);
    setError(null);
    if (open.kind === "take") {
      const r = await callApi<{ message: string | null }>(ORG_ROUTES.parts(c.id), { method: "DELETE", body: { tenantId: open.tenantId } });
      setBusy(null);
      if (!r.ok) return setError(r.message);
      if (r.data.message) setAfters((a) => ({ ...a, [c.id]: r.data.message! }));
      return done(null);
    }
    if (open.kind === "disconnect") {
      const r = await callApi<{ message: string }>(ORG_ROUTES.connection(c.id), { method: "DELETE" });
      setBusy(null);
      if (!r.ok) return setError(r.message);
      return done({ tone: "ok", text: r.data.message });
    }
    if (open.kind === "signin") {
      const r = await startOrganisationSignIn(c.connectorId, c.id);
      if (r.ok) {
        window.location.assign(r.data.url);
        return;
      }
      setBusy(null);
      return setError(r.message);
    }
    setBusy(null);
  }

  const unreadable = open?.kind === "after" ? open.c.parts.filter((p) => partUnreadable(p) && p.record?.health.lastErrorCode === "account_refused") : [];
  return (
    <section aria-labelledby="org-shared-h" className="space-y-4">
      <div className="space-y-1">
        <h2 id="org-shared-h" className="text-base font-semibold">
          {SHARED_COPY.title}
        </h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{SHARED_COPY.lead}</p>
      </div>
      {note ? (
        <p role="status" className={note.tone === "ok" ? NOTE_OK : NOTE_ERR}>
          {note.text}
        </p>
      ) : null}
      {screen.connections.length ? (
        <div className="space-y-4">
          {screen.connections.map((c) => (
            <SharedCard key={c.id} c={c} screen={screen} now={at} actions={actions} busy={busy === c.id} copied={copied === c.id} after={afters[c.id] ?? null} />
          ))}
        </div>
      ) : (
        <div className={`${NOTE_PLAIN} space-y-2`}>
          <p>{SHARED_COPY.none}</p>
          <Link href="/admin/account/connections/browse" className="font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">
            {SHARED_COPY.browse}
          </Link>
        </div>
      )}
      <HowToLink path={SHARED_HELP_PATH} className="inline-block text-sm font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">
        Help: Shared connections
      </HowToLink>

      {open && (open.kind === "give" || open.kind === "change") ? (
        <GivePartDialog c={open.c} screen={screen} mode={open.kind} brandId={open.kind === "change" ? open.tenantId : null} onClose={close} onDone={() => done(null)} />
      ) : null}
      {open?.kind === "take" ? <TakeBackDialog open={open} org={org} busy={busy !== null} error={error} onClose={close} onConfirm={confirm} /> : null}
      {open?.kind === "disconnect" ? (
        <DialogFrame
          open
          onClose={close}
          title={disconnectTitleWords(open.c.connectorName, org)}
          about={<ConnectionAbout c={open.c} org={org} />}
          footer={
            <>
              <button type="button" className={DANGER} disabled={busy !== null} onClick={confirm}>
                {SHARED_COPY.disconnect}
              </button>
              <button type="button" className={BUTTON} onClick={close}>
                {GIVE_COPY.cancel}
              </button>
            </>
          }
        >
          <p className="text-sm text-neutral-700 dark:text-neutral-300">{disconnectTextWords(open.c.parts.length)}</p>
          {screen.revoke && open.c.method === "oauth_pkce" ? (
            <p role="status" className={NOTE_WARN}>
              {REVOKE_WARNING}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className={NOTE_ERR}>
              {error}
            </p>
          ) : null}
        </DialogFrame>
      ) : null}
      {open?.kind === "signin" ? (
        <DialogFrame
          open
          onClose={close}
          title={signInAgainTitleWords(open.c.connectorName)}
          about={<ConnectionAbout c={open.c} org={org} />}
          footer={
            <>
              <button type="button" className={BUTTON_PRIMARY} disabled={busy !== null} onClick={confirm}>
                {GIVE_COPY.signInWithGoogle}
              </button>
              <button type="button" className={BUTTON} onClick={close}>
                {GIVE_COPY.cancel}
              </button>
            </>
          }
        >
          <p className="text-sm text-neutral-700 dark:text-neutral-300">{signInAgainTextWords(open.c.parts.map((p) => ({ brand: p.brandName, part: partWords(p.account, p.record?.label) })))}</p>
          {error ? (
            <p role="alert" className={NOTE_ERR}>
              {error}
            </p>
          ) : null}
        </DialogFrame>
      ) : null}
      {open?.kind === "after" ? (
        <DialogFrame
          open
          onClose={close}
          title={GIVE_COPY.signedInAgain}
          about={<ConnectionAbout c={open.c} org={org} />}
          footer={
            <button type="button" className={BUTTON_PRIMARY} onClick={close}>
              {GIVE_COPY.done}
            </button>
          }
        >
          {unreadable.length ? (
            unreadable.map((p) => (
              <p key={p.tenantId} role="status" className={NOTE_WARN}>
                {afterSignInWords(partWords(p.account, p.record?.label), p.brandName)}
              </p>
            ))
          ) : (
            <p className="text-sm text-neutral-700 dark:text-neutral-300">{signedInAgainWords(0)}</p>
          )}
        </DialogFrame>
      ) : null}
    </section>
  );
}

function TakeBackDialog({ open, org, busy, error, onClose, onConfirm }: { open: Extract<Open, { kind: "take" }>; org: string; busy: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  const p = open.c.parts.find((x) => x.tenantId === open.tenantId);
  if (!p) return null;
  const unit = partUnit(open.c.connectorId);
  const part = partWords(p.account, p.record?.label);
  return (
    <DialogFrame
      open
      onClose={onClose}
      title={takeBackTitleWords(p.brandName)}
      about={<ConnectionAbout c={open.c} org={org} extra={`, ${part}, given to ${p.brandName}.`} />}
      footer={
        <>
          <button type="button" className={DANGER} disabled={busy} onClick={onConfirm}>
            {SHARED_COPY.takeBack}
          </button>
          <button type="button" className={BUTTON} onClick={onClose}>
            {GIVE_COPY.cancel}
          </button>
        </>
      }
    >
      <p className="text-sm text-neutral-700 dark:text-neutral-300">{takeBackTextWords(p.brandName, unit.one, open.c.method, open.c.connectorName)}</p>
      {error ? (
        <p role="alert" className={NOTE_ERR}>
          {error}
        </p>
      ) : null}
    </DialogFrame>
  );
}
