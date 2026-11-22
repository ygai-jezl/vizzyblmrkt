"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HowToLink } from "@/components/help/HowToLink";
import type { ConnectionView, ConnectorListing } from "@/lib/connectors/service";
import { callApi, ROUTES, startSignIn } from "./api";
import { ConnectorTile } from "./BrowseView";
import {
  BUTTON,
  BUTTON_PRIMARY,
  CARD,
  CONNECTED_PATH,
  HELP_PATH,
  HINT,
  LISTING_COPY,
  NOTE_ERR,
  NOTE_OK,
  NOTE_WARN,
  TAG,
  TONE_CLASS,
  categoryLabel,
  connectorStatus,
  limitsOf,
  numbersOf,
  pickPath,
  readsOf,
  shareMethodOf,
  tokenMethodOf,
  waitingShareOf,
  waitingSignInOf,
  whoCanSeeOf,
  youNeedOf,
} from "./words";

export interface ListingProps {
  listing: ConnectorListing;
  /** The brand's connections to this connector, as this person may see them. */
  connections: ConnectionView[];
  isAdmin: boolean;
  /** Vizzy reads connected data (CONNECTORS_CHAT_ENABLED). */
  chat: boolean;
  /** What a sign in with Google came back with, in words. */
  banner: { tone: "ok" | "err"; text: string } | null;
  /** A token connection that was turned down, which connecting again replaces. */
  replace: ConnectionView | null;
}

const H3 = "text-sm font-semibold";

/**
 * A connector's Listing (Settings › Connections › Browse › one connector): how to connect, in the
 * manifest's order (Sign in with Google first, then share access, or an API token), what it reads
 * and the numbers it gives, from its manifest. Only admins connect; members read the same page.
 */
export function ListingView({ listing, connections, isAdmin, chat, banner, replace }: ListingProps) {
  const signIn = listing.ready.includes("oauth_pkce");
  const share = listing.ready.includes("share_access") && shareMethodOf(listing) !== null;
  const token = listing.ready.includes("token_fields") && tokenMethodOf(listing) !== null;
  const ways = [signIn, share, token].filter(Boolean).length;
  const status = connectorStatus(listing.id, connections);
  const live = connections.filter((c) => c.status === "connected");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <ConnectorTile id={listing.id} name={listing.name} size="lg" />
        <div className="space-y-0.5">
          <h2 className="text-lg font-semibold">{listing.name}</h2>
          <p className={HINT}>
            Built by YouGrow · {categoryLabel(listing.category)} · <span className={`${TAG} ${TONE_CLASS[status.tone]}`}>{status.label}</span>
          </p>
        </div>
      </div>
      <p className="max-w-3xl text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">{listing.summary}</p>
      {banner ? (
        <p role="status" className={banner.tone === "ok" ? NOTE_OK : NOTE_ERR}>
          {banner.text}
          {banner.tone === "ok" ? (
            <>
              {" "}
              <Link href={CONNECTED_PATH} className="font-medium underline underline-offset-2">
                Open Connected
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {live.length && !banner ? (
        <p className={HINT}>
          This brand has {live.length === 1 ? "1 connection" : `${live.length} connections`} to {listing.name}.{" "}
          <Link href={CONNECTED_PATH} className="font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">
            See Connected
          </Link>
        </p>
      ) : null}

      <div className="grid items-start gap-5 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
        <div className="space-y-4">
          {ways > 1 ? <h3 className={H3}>{LISTING_COPY.chooseHow}</h3> : null}
          {signIn ? <SignInCard listing={listing} isAdmin={isAdmin} alone={ways === 1} waiting={waitingSignInOf(connections, listing.id)} /> : null}
          {share ? <ShareCard listing={listing} isAdmin={isAdmin} afterSignIn={signIn} waiting={waitingShareOf(connections, listing.id)} /> : null}
          {token ? <TokenCard listing={listing} isAdmin={isAdmin} replace={replace} /> : null}
        </div>
        <div className="space-y-4">
          <ReadsCard listing={listing} />
          <AboutCard listing={listing} chat={chat} />
        </div>
      </div>
    </div>
  );
}

function SignInCard({ listing, isAdmin, alone, waiting }: { listing: ConnectorListing; isAdmin: boolean; alone: boolean; waiting: ConnectionView | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    const r = await startSignIn(listing.id);
    if (r.ok) {
      window.location.assign(r.data.url);
      return;
    }
    setError(r.message);
    setBusy(false);
  }

  return (
    <section aria-labelledby="connect-sign-in" className={`${CARD} space-y-3 ${alone ? "" : "border-sky-300 dark:border-sky-800"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="connect-sign-in" className={H3}>
          {LISTING_COPY.signInTitle}
        </h4>
        {alone ? null : <span className={`${TAG} border-sky-300 text-sky-800 dark:border-sky-800 dark:text-sky-300`}>{LISTING_COPY.quickest}</span>}
      </div>
      <p className="text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        Pick the Google account that can see your property. YouGrow asks only to read your {listing.name} data.
      </p>
      {waiting && isAdmin ? (
        <p className={NOTE_WARN}>
          {LISTING_COPY.signInWaiting}{" "}
          <Link href={pickPath(listing.id, waiting.id)} className="font-medium underline underline-offset-2">
            {LISTING_COPY.choose}
          </Link>
        </p>
      ) : null}
      {isAdmin ? (
        <button type="button" className={BUTTON_PRIMARY} onClick={go} disabled={busy}>
          {busy ? "Opening Google…" : LISTING_COPY.signInTitle}
        </button>
      ) : (
        <p className={HINT}>{LISTING_COPY.adminsOnly}</p>
      )}
      {error ? (
        <p role="alert" className={NOTE_ERR}>
          {error}
        </p>
      ) : null}
      <p className={HINT}>{listing.disconnect}</p>
    </section>
  );
}

function ShareCard({ listing, isAdmin, afterSignIn, waiting }: { listing: ConnectorListing; isAdmin: boolean; afterSignIn: boolean; waiting: ConnectionView | null }) {
  const router = useRouter();
  const method = shareMethodOf(listing)!;
  const [made, setMade] = useState<{ id: string; email: string } | null>(() =>
    waiting?.details?.serviceAccount ? { id: waiting.id, email: waiting.details.serviceAccount.email } : null,
  );
  const [busy, setBusy] = useState<"make" | "check" | null>(null);
  const [note, setNote] = useState<{ tone: "warn" | "err"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function make() {
    setBusy("make");
    setNote(null);
    const r = await callApi<{ connection: ConnectionView; share: { email: string } }>(ROUTES.share(listing.id), { method: "POST", body: {} });
    setBusy(null);
    if (!r.ok) {
      setNote({ tone: "err", text: r.message });
      return;
    }
    setMade({ id: r.data.connection.id, email: r.data.share.email });
    router.refresh();
  }

  async function check() {
    if (!made) return;
    setBusy("check");
    setNote(null);
    const r = await callApi<{ visible: boolean; message: string | null }>(ROUTES.access(made.id), { method: "POST" });
    setBusy(null);
    if (!r.ok) {
      setNote({ tone: r.status === 409 ? "warn" : "err", text: r.message });
      return;
    }
    if (r.data.visible) {
      router.push(pickPath(listing.id, made.id));
      return;
    }
    setNote({ tone: "warn", text: r.data.message ?? LISTING_COPY.checkHint });
  }

  async function copy() {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.email);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard here: the address is on screen to select.
    }
  }

  return (
    <section aria-labelledby="connect-share" className={`${CARD} space-y-3`}>
      <h4 id="connect-share" className={H3}>
        {afterSignIn ? LISTING_COPY.shareTitleOr : LISTING_COPY.shareTitle}
      </h4>
      <p className="text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">{LISTING_COPY.shareLead}</p>
      {!isAdmin ? (
        <p className={HINT}>{LISTING_COPY.adminsOnly}</p>
      ) : !made ? (
        <button type="button" className={BUTTON} onClick={make} disabled={busy !== null}>
          {busy === "make" ? "Making the address…" : LISTING_COPY.shareStart}
        </button>
      ) : (
        <>
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
            <li>
              <span className="block">{LISTING_COPY.copyStep}</span>
              <span className="mt-1 flex flex-wrap items-center gap-2">
                <code className="break-all rounded-md border border-neutral-300 bg-neutral-50 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900">{made.email}</code>
                <button type="button" className={BUTTON} onClick={copy}>
                  {copied ? LISTING_COPY.copied : "Copy"}
                </button>
              </span>
            </li>
            {method.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="space-y-1">
            <button type="button" className={BUTTON_PRIMARY} onClick={check} disabled={busy !== null}>
              {busy === "check" ? "Checking…" : LISTING_COPY.checkAccess}
            </button>
            <p className={HINT}>{LISTING_COPY.checkHint}</p>
          </div>
        </>
      )}
      {note ? (
        <p role="alert" className={note.tone === "warn" ? NOTE_WARN : NOTE_ERR}>
          {note.text}
        </p>
      ) : null}
      <p className={HINT}>Removing the address in {listing.name} ends access straight away.</p>
    </section>
  );
}

function TokenCard({ listing, isAdmin, replace }: { listing: ConnectorListing; isAdmin: boolean; replace: ConnectionView | null }) {
  const router = useRouter();
  const method = tokenMethodOf(listing)!;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(method.fields.map((f) => [f.key, f.key === method.account && replace?.details ? replace.details.account : ""])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (replace) {
      const gone = await callApi(ROUTES.connection(replace.id), { method: "DELETE" });
      if (!gone.ok && gone.status !== 404) {
        setError(gone.message);
        setBusy(false);
        return;
      }
    }
    const r = await callApi<ConnectionView>(ROUTES.connect(listing.id), { method: "POST", body: { fields: values } });
    if (!r.ok) {
      setError(r.message);
      setBusy(false);
      return;
    }
    const grants = replace?.details?.grants ?? [];
    if (grants.length) await callApi(ROUTES.grants(r.data.id), { method: "PUT", body: { grants } });
    router.push(CONNECTED_PATH);
    router.refresh();
  }

  return (
    <form aria-labelledby="connect-token" className={`${CARD} space-y-4`} onSubmit={submit}>
      <h4 id="connect-token" className={H3}>
        {LISTING_COPY.tokenTitle}
      </h4>
      <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        {method.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {method.tokenLink ? (
        <a href={method.tokenLink} target="_blank" rel="noreferrer" className="inline-block text-sm font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">
          Open {listing.name} with the form filled in
        </a>
      ) : null}
      {replace ? <p className={NOTE_WARN}>{LISTING_COPY.tokenReconnect}</p> : null}
      {isAdmin ? (
        <>
          {method.fields.map((f) => (
            <div key={f.key} className="space-y-1">
              <label htmlFor={`field-${f.key}`} className="block text-sm font-medium">
                {f.label}
              </label>
              <input
                id={`field-${f.key}`}
                name={f.key}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                required
                minLength={f.minLength}
                maxLength={f.maxLength}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-3 font-mono text-sm dark:border-neutral-700"
              />
              {f.help ? <p className={HINT}>{f.help}</p> : null}
            </div>
          ))}
          <p className={HINT}>{LISTING_COPY.tokenCheck}</p>
          {error ? (
            <p role="alert" className={NOTE_ERR}>
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={BUTTON_PRIMARY} disabled={busy}>
              {busy ? "Checking the token…" : "Connect"}
            </button>
            <Link href="/admin/account/connections/browse" className={BUTTON}>
              Cancel
            </Link>
          </div>
        </>
      ) : (
        <p className={HINT}>{LISTING_COPY.adminsOnly}</p>
      )}
    </form>
  );
}

function ReadsCard({ listing }: { listing: ConnectorListing }) {
  const { rows, never } = readsOf(listing);
  const { numbers, lag } = numbersOf(listing);
  const th = "border-b border-neutral-200 px-3 py-2 text-left text-xs font-medium text-neutral-500 dark:border-neutral-800 dark:text-neutral-400";
  const td = "border-b border-neutral-100 px-3 py-2 align-top last:border-b-0 dark:border-neutral-900";
  return (
    <section aria-labelledby="connector-reads" className={`${CARD} space-y-3`}>
      <h3 id="connector-reads" className={H3}>
        {LISTING_COPY.readsTitle}
      </h3>
      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className={th}>From {listing.name}</th>
              <th className={th}>What</th>
              <th className={th}>In YouGrow</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.what}>
                <td className={td}>{r.what}</td>
                <td className={td}>{r.detail}</td>
                <td className={td}>{r.where}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {never.map((n) => (
        <p key={n} className={HINT}>
          {n}
        </p>
      ))}
      {numbers.length ? (
        <>
          <h4 className={H3}>{LISTING_COPY.numbersTitle}</h4>
          <dl className="space-y-2 text-sm">
            {numbers.map((n) => (
              <div key={n.name}>
                <dt className="font-medium">{n.name}</dt>
                <dd className={HINT}>{n.definition}</dd>
              </div>
            ))}
          </dl>
          {lag.map((l) => (
            <p key={l} className={HINT}>
              {l}
            </p>
          ))}
        </>
      ) : null}
    </section>
  );
}

function AboutCard({ listing, chat }: { listing: ConnectorListing; chat: boolean }) {
  const rows: Array<[string, string[]]> = [
    [LISTING_COPY.youNeed, [youNeedOf(listing)]],
    [LISTING_COPY.limits, limitsOf(listing, chat)],
    [LISTING_COPY.whoCanSee, [whoCanSeeOf(chat)]],
    [LISTING_COPY.disconnect, [listing.disconnect]],
  ];
  return (
    <aside aria-label={LISTING_COPY.aboutLabel} className={`${CARD} space-y-3`}>
      {rows.map(([label, lines]) => (
        <div key={label}>
          <p className="text-sm font-semibold">{label}</p>
          {lines.map((l) => (
            <p key={l} className={`mt-1 ${HINT}`}>
              {l}
            </p>
          ))}
        </div>
      ))}
      <HowToLink path={`${HELP_PATH}#${listing.id}`} className="inline-block text-sm font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">
        Help: Connected data
      </HowToLink>
    </aside>
  );
}
