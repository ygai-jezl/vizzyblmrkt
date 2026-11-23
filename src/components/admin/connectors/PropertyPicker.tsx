"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ConnectorAccount } from "@/lib/connectors/handlers/types";
import { CONNECTOR_ERRORS } from "@/lib/connectors/messages";
import type { ConnectorIcon } from "@/lib/connectors/manifest";
import { callApi, ROUTES } from "./api";
import { ConnectorTile } from "./ConnectorTile";
import { BUTTON, BUTTON_PRIMARY, CARD, CONNECTED_PATH, HINT, NOTE_ERR, NOTE_WARN, PICKER_COPY, domainNote, listingPath, preselected } from "./words";

export interface PickerProps {
  connectorId: string;
  connectorName: string;
  /** The connector's tile beside its name: its marks, or the two letters its manifest gives. */
  connectorIcon?: ConnectorIcon;
  connectorInitials?: string;
  connectionId: string;
  method: "oauth_pkce" | "share_access";
  /** A shared connection's Google address, to say who sees the list. */
  sharedWith: string | null;
  /** What it reads now, or "" for a new connection. */
  current: string;
  /** The brand's own website (its root domain), or null when it has none. */
  rootDomain: string | null;
  /** The manifest's line about which ones the list leaves out. */
  listedNote: string | null;
}

type Loaded = { accounts: ConnectorAccount[]; more: boolean; current: string };

/**
 * After Sign in with Google or Check access: choose the site or property this connection reads.
 * Lists what the sign in or the shared address sees (GET .../accounts), marks one that isn't on
 * the brand's own website without blocking it, and saves the choice (PUT .../accounts). Cancel
 * on a new connection disconnects it, which deletes the sign in or the shared address.
 */
export function PropertyPicker(props: PickerProps) {
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    callApi<Loaded>(ROUTES.accounts(props.connectionId)).then((r) => {
      if (!alive) return;
      if (!r.ok) {
        setLoadError(r.message);
        return;
      }
      setLoaded(r.data);
      setChosen(preselected(r.data.accounts, r.data.current, props.rootDomain));
    });
    return () => {
      alive = false;
    };
  }, [props.connectionId, props.rootDomain]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    setBusy("save");
    setError(null);
    const r = await callApi(ROUTES.accounts(props.connectionId), { method: "PUT", body: { account: chosen } });
    if (!r.ok) {
      setError(r.message);
      setBusy(null);
      return;
    }
    router.push(CONNECTED_PATH);
    router.refresh();
  }

  async function cancel() {
    setBusy("cancel");
    setError(null);
    const r = await callApi(ROUTES.connection(props.connectionId), { method: "DELETE" });
    if (!r.ok && r.status !== 404) {
      setError(r.message);
      setBusy(null);
      return;
    }
    router.push(listingPath(props.connectorId));
    router.refresh();
  }

  return (
    <PickerForm
      {...props}
      loaded={loaded}
      loadError={loadError}
      chosen={chosen}
      onChoose={setChosen}
      busy={busy}
      error={error}
      onSubmit={save}
      onCancel={cancel}
    />
  );
}

/** The picker as it looks for a given state, so the tests can read every state without a browser. */
export function PickerForm({
  connectorId,
  connectorName,
  connectorIcon,
  connectorInitials,
  method,
  sharedWith,
  current,
  rootDomain,
  listedNote,
  loaded,
  loadError,
  chosen,
  onChoose,
  busy,
  error,
  onSubmit,
  onCancel,
}: PickerProps & {
  loaded: Loaded | null;
  loadError: string | null;
  chosen: string | null;
  onChoose: (id: string) => void;
  busy: "save" | "cancel" | null;
  error: string | null;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
}) {
  const isNew = !current;
  const empty = loaded !== null && loaded.accounts.length === 0;
  return (
    <form aria-labelledby="pick-title" onSubmit={onSubmit} className={`${CARD} mx-auto w-full max-w-xl space-y-4`}>
      <p className="flex items-center gap-2 text-sm font-medium">
        <ConnectorTile id={connectorId} name={connectorName} initials={connectorInitials} icon={connectorIcon} size="sm" />
        {connectorName}
      </p>
      <p className="text-sm text-green-700 dark:text-green-400">{method === "share_access" && sharedWith ? `Shared with ${sharedWith}` : PICKER_COPY.signedIn}</p>
      <h2 id="pick-title" className="text-lg font-semibold">
        {PICKER_COPY.title}
      </h2>
      <p className={HINT}>
        {`These are the ${connectorName} properties ${method === "share_access" ? "the address" : "this Google account"} can see.`}
        {listedNote ? ` ${listedNote}` : ""}
      </p>
      {loadError ? (
        <p role="alert" className={NOTE_ERR}>
          {loadError}
        </p>
      ) : loaded === null ? (
        <p className={HINT}>{PICKER_COPY.loading}</p>
      ) : empty ? (
        <p className={NOTE_WARN}>{method === "share_access" ? CONNECTOR_ERRORS.share_not_visible : PICKER_COPY.noneSignedIn}</p>
      ) : (
        <fieldset className="space-y-2">
          <legend className="sr-only">Property</legend>
          {loaded.accounts.map((a) => {
            const note = domainNote(a, rootDomain);
            const on = chosen === a.id;
            return (
              <label
                key={a.id}
                className={`flex cursor-pointer flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border px-3 py-2.5 text-sm ${
                  on ? "border-sky-400 bg-sky-50 dark:border-sky-700 dark:bg-sky-950/40" : "border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
                }`}
              >
                <input type="radio" name="account" value={a.id} checked={on} onChange={() => onChoose(a.id)} className="mt-0.5" />
                <span className="min-w-0 flex-1 break-words">
                  {a.label}
                  {note ? <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-400">{note}</span> : null}
                </span>
                {a.detail ? <span className={HINT}>{a.detail}</span> : null}
              </label>
            );
          })}
          {loaded.more ? <p className={HINT}>{`Only the first ${loaded.accounts.length} are listed.`}</p> : null}
        </fieldset>
      )}
      {error ? (
        <p role="alert" className={NOTE_ERR}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={BUTTON_PRIMARY} disabled={!chosen || busy !== null || !loaded || empty}>
          {busy === "save" ? "Checking…" : isNew ? PICKER_COPY.connect : PICKER_COPY.change}
        </button>
        {isNew ? (
          <button type="button" className={BUTTON} onClick={onCancel} disabled={busy !== null}>
            {busy === "cancel" ? "Cancelling…" : "Cancel"}
          </button>
        ) : (
          <Link href={CONNECTED_PATH} className={BUTTON}>
            Cancel
          </Link>
        )}
      </div>
      <p className={HINT}>{isNew ? PICKER_COPY.newHint : PICKER_COPY.changeHint}</p>
      {empty ? (
        <Link href={listingPath(connectorId)} className="text-sm font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">
          Back to {connectorName}
        </Link>
      ) : null}
    </form>
  );
}
