"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HowToLink } from "@/components/help/HowToLink";
import type { ConnectorAccount } from "@/lib/connectors/handlers/types";
import type { OrganisationListing } from "@/lib/connectors/organisationConnect";
import type { ConnectionView, ConnectorListing } from "@/lib/connectors/service";
import { callApi, ORG_ROUTES, ROUTES, startOrganisationSignIn, startSignIn } from "./api";
import { ConnectorLockup, ConnectorTile, GoogleSignInArt } from "./ConnectorTile";
import { checkPastedToken, connectWithToken, secretsOf } from "./tokenConnect";
import {
  BUTTON,
  BUTTON_PRIMARY,
  CARD,
  CONNECT_FOR_COPY,
  CONNECTED_PATH,
  HELP_PATH,
  HINT,
  LISTING_COPY,
  NOTE_ERR,
  NOTE_OK,
  NOTE_WARN,
  ORGANISATION_PATH,
  TAG,
  TONE_CLASS,
  categoryLabel,
  chosenAtFirst,
  connectorStatus,
  limitsOf,
  moreListedWords,
  numbersOf,
  partUnit,
  pickPath,
  readsOf,
  shareMethodOf,
  tokenCheckedWords,
  tokenMethodOf,
  typedWhyWords,
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
  /**
   * For an owner of the brand's organisation, while sharing is on (Connectors 3): "Connect for"
   * this brand or the organisation, where a sign in would be kept, and a Google address made for
   * the organisation still waiting for its first property. Null for everyone else.
   */
  organisation?: OrganisationListing | null;
}

const H3 = "text-sm font-semibold";

/** A card's title: under "Choose how to connect" when there is a choice, else straight under the name. */
type CardHeading = "h3" | "h4";

/**
 * A connector's Listing (Settings › Connections › Browse › one connector): how to connect, in the
 * manifest's order (Sign in with Google first, then share access, or an API token), what it reads
 * and the numbers it gives, from its manifest. Only admins connect; members read the same page.
 * An owner of the brand's organisation chooses first whether to connect for this brand or for the
 * organisation, whose owners then give each brand its part on Settings › Organisation.
 */
export function ListingView({ listing, connections, isAdmin, chat, banner, replace, organisation = null }: ListingProps) {
  const signIn = listing.ready.includes("oauth_pkce");
  const share = listing.ready.includes("share_access") && shareMethodOf(listing) !== null;
  const token = listing.ready.includes("token_fields") && tokenMethodOf(listing) !== null;
  const ways = [signIn, share, token].filter(Boolean).length;
  const heading: CardHeading = ways > 1 ? "h4" : "h3";
  const status = connectorStatus(listing.id, connections);
  const live = connections.filter((c) => c.status === "connected");
  const canShare = Boolean(isAdmin && organisation?.shareable);
  const [forOrg, setForOrg] = useState(false);
  const org = canShare && forOrg ? organisation : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <ConnectorTile id={listing.id} name={listing.name} initials={listing.initials} icon={listing.icon} size="lg" />
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
          {canShare && organisation ? <ConnectFor brand={organisation.brandName} org={organisation} forOrg={forOrg} onChange={setForOrg} /> : null}
          {ways > 1 ? <h3 className={H3}>{LISTING_COPY.chooseHow}</h3> : null}
          {signIn ? <SignInCard listing={listing} isAdmin={isAdmin} alone={ways === 1} heading={heading} waiting={org ? null : waitingSignInOf(connections, listing.id)} org={org} /> : null}
          {share ? (
            <ShareCard key={org ? "org" : "brand"} listing={listing} isAdmin={isAdmin} afterSignIn={signIn} heading={heading} waiting={org ? null : waitingShareOf(connections, listing.id)} org={org} />
          ) : null}
          {token ? org ? <OrgTokenCard listing={listing} heading={heading} org={org} /> : <TokenCard listing={listing} isAdmin={isAdmin} chat={chat} heading={heading} replace={replace} /> : null}
        </div>
        <div className="space-y-4">
          <ReadsCard listing={listing} />
          <AboutCard listing={listing} chat={chat} />
        </div>
      </div>
    </div>
  );
}

/** "Connect for": this brand, or the organisation and all its brands, saying where a sign in is kept. */
export function ConnectFor({ brand, org, forOrg, onChange }: { brand: string; org: OrganisationListing; forOrg: boolean; onChange: (forOrg: boolean) => void }) {
  const option = (on: boolean) =>
    `flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${on ? "border-sky-400 bg-sky-50 dark:border-sky-700 dark:bg-sky-950/40" : "border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"}`;
  return (
    <fieldset className="space-y-2">
      <legend className={`${H3} mb-2`}>{CONNECT_FOR_COPY.legend}</legend>
      <label className={option(!forOrg)}>
        <input type="radio" name="connect-for" value="brand" checked={!forOrg} onChange={() => onChange(false)} className="mt-0.5" />
        <span>{CONNECT_FOR_COPY.thisBrand(brand)}</span>
      </label>
      <label className={option(forOrg)}>
        <input type="radio" name="connect-for" value="organisation" checked={forOrg} onChange={() => onChange(true)} className="mt-0.5" />
        <span>
          {CONNECT_FOR_COPY.organisation(org.name)}
          {forOrg ? <span className={`mt-0.5 block ${HINT}`}>{CONNECT_FOR_COPY.keptIn(org.regionName, brand)}</span> : null}
        </span>
      </label>
    </fieldset>
  );
}

function SignInCard({
  listing,
  isAdmin,
  alone,
  heading: Title,
  waiting,
  org = null,
}: {
  listing: ConnectorListing;
  isAdmin: boolean;
  alone: boolean;
  heading: CardHeading;
  waiting: ConnectionView | null;
  /** Connecting for the organisation: its consent line shows before Google's screen. */
  org?: OrganisationListing | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    const r = org ? await startOrganisationSignIn(listing.id) : await startSignIn(listing.id);
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
        <Title id="connect-sign-in" className={H3}>
          {LISTING_COPY.signInTitle}
        </Title>
        {alone ? null : <span className={`${TAG} border-sky-300 text-sky-800 dark:border-sky-800 dark:text-sky-300`}>{LISTING_COPY.quickest}</span>}
      </div>
      <p className="text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        Pick the Google account that can see your property. YouGrow asks only to read your {listing.name} data.
      </p>
      {org ? (
        <p id="connect-consent" className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          {CONNECT_FOR_COPY.consent(org.name, partUnit(listing.id).one)}
        </p>
      ) : null}
      {waiting && isAdmin ? (
        <p className={NOTE_WARN}>
          {LISTING_COPY.signInWaiting}{" "}
          <Link href={pickPath(listing.id, waiting.id)} className="font-medium underline underline-offset-2">
            {LISTING_COPY.choose}
          </Link>
        </p>
      ) : null}
      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-3">
          {/* Google's own button art inside our button: its name is the art's alt text. */}
          <button
            type="button"
            className="inline-flex rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50"
            onClick={go}
            disabled={busy}
            aria-describedby={org ? "connect-consent" : undefined}
          >
            <GoogleSignInArt alt={LISTING_COPY.signInTitle} />
          </button>
          {busy ? (
            <span role="status" className={HINT}>
              {LISTING_COPY.openingGoogle}
            </span>
          ) : null}
        </div>
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

function ShareCard({
  listing,
  isAdmin,
  afterSignIn,
  heading: Title,
  waiting,
  org = null,
}: {
  listing: ConnectorListing;
  isAdmin: boolean;
  afterSignIn: boolean;
  heading: CardHeading;
  waiting: ConnectionView | null;
  /** Making the address for the organisation: its own, then Settings › Organisation gives each brand its part. */
  org?: OrganisationListing | null;
}) {
  const router = useRouter();
  const method = shareMethodOf(listing)!;
  const [made, setMade] = useState<{ id: string; email: string } | null>(() =>
    org ? (org.waitingShare ? { ...org.waitingShare } : null) : waiting?.details?.serviceAccount ? { id: waiting.id, email: waiting.details.serviceAccount.email } : null,
  );
  const [busy, setBusy] = useState<"make" | "check" | null>(null);
  const [note, setNote] = useState<{ tone: "warn" | "err"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function make() {
    setBusy("make");
    setNote(null);
    if (org) {
      const o = await callApi<{ connectionId: string; share: { email: string } }>(ORG_ROUTES.list, { method: "POST", body: { connectorId: listing.id, method: "share_access" } });
      setBusy(null);
      if (!o.ok) {
        setNote({ tone: "err", text: o.message });
        return;
      }
      setMade({ id: o.data.connectionId, email: o.data.share.email });
      return;
    }
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
    const r = await callApi<{ visible: boolean; message: string | null }>(org ? ORG_ROUTES.access(made.id) : ROUTES.access(made.id), { method: "POST" });
    setBusy(null);
    if (!r.ok) {
      setNote({ tone: r.status === 409 ? "warn" : "err", text: r.message });
      return;
    }
    if (r.data.visible) {
      router.push(org ? `${ORGANISATION_PATH}?${new URLSearchParams({ status: "connected", connection: made.id })}` : pickPath(listing.id, made.id));
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
      <Title id="connect-share" className={H3}>
        {afterSignIn ? LISTING_COPY.shareTitleOr : LISTING_COPY.shareTitle}
      </Title>
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

function TokenCard({
  listing,
  isAdmin,
  chat,
  heading: Title,
  replace,
}: {
  listing: ConnectorListing;
  isAdmin: boolean;
  chat: boolean;
  heading: CardHeading;
  replace: ConnectionView | null;
}) {
  const router = useRouter();
  const method = tokenMethodOf(listing)!;
  const pick = method.pick ?? null;
  const accountField = method.fields.find((f) => f.key === method.account)!;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(method.fields.map((f) => [f.key, f.key === method.account && replace?.details && !pick ? replace.details.account : ""])),
  );
  /** After Check, on a Listing that picks from a list: what the token can see, or that the account is typed. */
  const [checked, setChecked] = useState<{ accounts: ConnectorAccount[]; more: boolean } | null>(null);
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState<"check" | "connect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Connected, but who can read it didn't carry over: the form is done, so it can't connect twice. */
  const [lost, setLost] = useState<string | null>(null);
  // Check and Connect wait for the page's script: a form sent before it would go by the browser alone.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  // The form as it is now, for a Check's answer to compare with the token it sent.
  const latest = useRef(values);
  useEffect(() => {
    latest.current = values;
  }, [values]);

  /** A pick Listing shows the account only after Check: from the list, or typed when it can't list. */
  const stage = !pick ? "all" : !checked ? "token" : typing || !checked.accounts.length ? "typed" : "listed";
  const shown = method.fields.filter((f) => stage === "all" || f.secret || (stage === "typed" && f.key === method.account));
  const set = (key: string, value: string) => {
    // A changed token has to be checked again before it connects.
    const recheck = Boolean(pick && method.fields.find((f) => f.key === key)?.secret);
    setValues((v) => ({ ...v, [key]: value, ...(recheck ? { [method.account]: "" } : {}) }));
    if (recheck) {
      setChecked(null);
      setTyping(false);
    }
  };
  /** Switch between the list and typing the account, so the list never shows one it doesn't have. */
  const typeInstead = (on: boolean) => {
    setTyping(on);
    setValues((v) => ({ ...v, [method.account]: on ? "" : chosenAtFirst(checked?.accounts ?? [], replace?.details?.account) }));
  };

  async function check() {
    setBusy("check");
    setError(null);
    const secrets = secretsOf(method.fields, values);
    const r = await checkPastedToken(listing.id, secrets, undefined, () => secretsOf(method.fields, latest.current));
    setBusy(null);
    // The token changed while Check ran: the edit already cleared the check, so it is pressed again.
    if (r.kind === "stale") return;
    if (r.kind === "refused") {
      setError(r.message);
      return;
    }
    const accounts = r.kind === "listed" ? r.accounts : [];
    setChecked({ accounts, more: r.kind === "listed" && r.more });
    setTyping(false);
    // A Reconnect starts on the zone it replaces, picked from the list or typed in.
    setValues((v) => ({ ...v, [method.account]: r.kind === "listed" ? chosenAtFirst(accounts, replace?.details?.account) : (replace?.details?.account ?? "") }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (stage === "token") return check();
    setBusy("connect");
    setError(null);
    // Named by the zone picked from the list; a Reconnect on the same account keeps its name.
    const picked = stage === "listed" ? checked?.accounts.find((a) => a.id === chosen)?.label : undefined;
    const kept = replace && replace.label !== replace.connectorName && replace.details?.account === chosen ? replace.label : undefined;
    const r = await connectWithToken(listing.id, values, replace, chat, undefined, picked ?? kept);
    if (r.kind === "connected") {
      router.push(CONNECTED_PATH);
      router.refresh();
      return;
    }
    setBusy(null);
    if (r.kind === "refused") {
      setError(r.message);
      return;
    }
    setLost(r.message);
    router.refresh();
  }

  const input = "h-9 w-full rounded-md border border-neutral-300 bg-transparent px-3 font-mono text-sm dark:border-neutral-700";
  const chosen = values[method.account] ?? "";

  return (
    // A token never goes in an address: the fields have no name, so the browser has nothing to send
    // on its own, and the form posts rather than putting fields in the URL. The handler sends them.
    <form method="post" aria-labelledby="connect-token" className={`${CARD} space-y-4`} onSubmit={submit}>
      <Title id="connect-token" className={H3}>
        {LISTING_COPY.tokenTitle}
      </Title>
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
      {replace && !lost ? <p className={NOTE_WARN}>{LISTING_COPY.tokenReconnect}</p> : null}
      {lost ? (
        <p role="alert" className={NOTE_WARN}>
          {lost}{" "}
          <Link href={CONNECTED_PATH} className="font-medium underline underline-offset-2">
            {LISTING_COPY.openConnected}
          </Link>
        </p>
      ) : isAdmin ? (
        <>
          {shown.map((f) => (
            <div key={f.key} className="space-y-1">
              <label htmlFor={`field-${f.key}`} className="block text-sm font-medium">
                {f.label}
              </label>
              <input
                id={`field-${f.key}`}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                required
                minLength={f.minLength}
                maxLength={f.maxLength}
                value={values[f.key] ?? ""}
                // The token Check is checking stays as it was until the answer comes.
                readOnly={f.secret && busy === "check"}
                onChange={(e) => set(f.key, e.target.value)}
                className={input}
              />
              {f.help ? <p className={HINT}>{f.help}</p> : null}
            </div>
          ))}
          {stage === "listed" && checked ? (
            <div className="space-y-1">
              <label htmlFor={`field-${method.account}`} className="block text-sm font-medium">
                {pick!.label}
              </label>
              <select id={`field-${method.account}`} required value={chosen} onChange={(e) => set(method.account, e.target.value)} className={input}>
                {chosen ? null : (
                  <option value="" disabled>
                    {LISTING_COPY.chooseOne}
                  </option>
                )}
                {checked.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.detail ? `${a.label} (${a.detail})` : a.label}
                  </option>
                ))}
              </select>
              <p className={HINT}>{LISTING_COPY.listedHint}</p>
              {checked.more ? (
                <p className={HINT}>
                  {moreListedWords(listing.name, accountField.label)}{" "}
                  <button type="button" className="font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400" onClick={() => typeInstead(true)}>
                    Type the {accountField.label}
                  </button>
                </p>
              ) : null}
            </div>
          ) : null}
          {stage === "listed" && checked ? (
            <p role="status" className={NOTE_OK}>
              {tokenCheckedWords(checked.accounts, chosen)}
            </p>
          ) : stage === "typed" && checked ? (
            // Typed because the token can't list them, or because more were listed than fit: each in its own words.
            <TypedWhy text={typedWhyWords(listing.name, accountField.label, pick!, checked.accounts.length > 0)} listed={checked.accounts.length > 0} onPick={() => typeInstead(false)} />
          ) : (
            <p className={HINT}>{stage === "token" ? LISTING_COPY.checkFirst : LISTING_COPY.tokenCheck}</p>
          )}
          {error ? (
            <p role="alert" className={NOTE_ERR}>
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={BUTTON_PRIMARY} disabled={busy !== null || !ready || (stage !== "token" && stage !== "all" && !chosen)}>
              {stage === "token" ? (busy === "check" ? LISTING_COPY.checking : LISTING_COPY.check) : busy === "connect" ? "Checking the token…" : "Connect"}
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

/**
 * A pasted token for the organisation: only its secret fields, since each brand gets its own zone
 * later. YouGrow checks it by listing the zones it reaches, then seals it for the organisation.
 */
function OrgTokenCard({ listing, heading: Title, org }: { listing: ConnectorListing; heading: CardHeading; org: OrganisationListing }) {
  const router = useRouter();
  const method = tokenMethodOf(listing)!;
  const secretFields = method.fields.filter((f) => f.secret);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(secretFields.map((f) => [f.key, ""])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await callApi<{ connectionId: string }>(ORG_ROUTES.list, { method: "POST", body: { connectorId: listing.id, method: "token_fields", fields: secretsOf(method.fields, values) } });
    if (r.ok) {
      router.push(`${ORGANISATION_PATH}?${new URLSearchParams({ status: "connected", connection: r.data.connectionId })}`);
      return;
    }
    setBusy(false);
    setError(r.message);
  }

  const input = "h-9 w-full rounded-md border border-neutral-300 bg-transparent px-3 font-mono text-sm dark:border-neutral-700";
  return (
    <form method="post" aria-labelledby="connect-token" className={`${CARD} space-y-4`} onSubmit={submit}>
      <Title id="connect-token" className={H3}>
        {LISTING_COPY.tokenTitle}
      </Title>
      <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        {method.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className={NOTE_WARN}>{CONNECT_FOR_COPY.tokenHint(org.name)}</p>
      {method.tokenLink ? (
        <a href={method.tokenLink} target="_blank" rel="noreferrer" className="inline-block text-sm font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">
          Open {listing.name} with the form filled in
        </a>
      ) : null}
      {secretFields.map((f) => (
        <div key={f.key} className="space-y-1">
          <label htmlFor={`org-field-${f.key}`} className="block text-sm font-medium">
            {f.label}
          </label>
          <input
            id={`org-field-${f.key}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            minLength={f.minLength}
            maxLength={f.maxLength}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            className={input}
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
        <button type="submit" className={BUTTON_PRIMARY} disabled={busy || !ready}>
          {busy ? CONNECT_FOR_COPY.connecting : CONNECT_FOR_COPY.tokenConnect}
        </button>
        <Link href="/admin/account/connections/browse" className={BUTTON}>
          Cancel
        </Link>
      </div>
    </form>
  );
}

/** Why the account is typed: a warning when the token can't list them, else a hint and the way back to the list. */
export function TypedWhy({ text, listed, onPick }: { text: string; listed: boolean; onPick: () => void }) {
  if (!listed) {
    return (
      <p role="status" className={NOTE_WARN}>
        {text}
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p role="status" className={HINT}>
        {text}
      </p>
      <button type="button" className="text-sm font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400" onClick={onPick}>
        {LISTING_COPY.pickFromList}
      </button>
    </div>
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
      {listing.icon?.lockup ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-neutral-100 pt-3 dark:border-neutral-900">
          <span className={HINT}>{LISTING_COPY.dataFrom}</span>
          <ConnectorLockup lockup={listing.icon.lockup} />
        </div>
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
