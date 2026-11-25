"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { SharedConnectionsScreen, SharedConnectionView } from "@/lib/connectors/organisationConnect";
import type { OrganisationAccount } from "@/lib/connectors/organisationParts";
import { useThemePortalContainer } from "@/components/admin/nav/AdminThemeRoot";
import { callApi, ORG_ROUTES } from "./api";
import { ConnectorTile } from "./ConnectorTile";
import {
  BUTTON,
  BUTTON_PRIMARY,
  GIVE_COPY,
  HINT,
  NOTE_ERR,
  NOTE_WARN,
  accountOptionsFor,
  brandOptionsFor,
  changeButtonWords,
  changeTextWords,
  changeTitleWords,
  firstPartFor,
  giveButtonWords,
  giveTitleWords,
  notSignerDialogWords,
  partUnit,
  partWords,
  productWords,
  readersForWords,
  readsForWords,
  sharedHowWords,
  unitOf,
} from "./words";

/** A dialog over Settings › Organisation: its title, the connection it is about, its body and its buttons. */
export function DialogFrame({ open, onClose, title, about, children, footer }: { open: boolean; onClose: () => void; title: string; about: ReactNode; children: ReactNode; footer: ReactNode }) {
  // Inside the admin theme root, so the app's Light or Dark choice wins over the computer's.
  const container = useThemePortalContainer();
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed inset-x-4 top-[8vh] z-50 mx-auto flex max-h-[84vh] max-w-xl flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-neutral-950">
          <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4 dark:border-neutral-800">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close aria-label={GIVE_COPY.close} className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900">
              <X size={16} aria-hidden />
            </Dialog.Close>
          </div>
          <div className="space-y-4 overflow-y-auto px-5 py-4">
            <Dialog.Description asChild>
              <div className="text-sm">{about}</div>
            </Dialog.Description>
            {children}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">{footer}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The connection a dialog is about: its tile, its name and how it signs in, and where it is kept. */
export function ConnectionAbout({ c, org, extra }: { c: SharedConnectionView; org: string; extra?: string }) {
  return (
    <p className="flex items-center gap-2">
      <ConnectorTile id={c.connectorId} name={c.connectorName} initials={c.connectorInitials} icon={c.connectorIcon} size="sm" />
      <span className="min-w-0">
        <span className="font-medium">{productWords(c.connectorName)}</span>
        {extra ?? `${sharedHowWords(c, org)} Kept in ${c.regionName}.`}
      </span>
    </p>
  );
}

/**
 * A radio card, as the property picker draws one: sky when chosen, greyed when it can't be. Greyed is
 * the hint colour on the label, never a fade of the whole card, so the note that says why stays as
 * readable as any hint.
 */
export const OPTION = (on: boolean, off: boolean) =>
  `flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${off ? "cursor-default border-neutral-200 text-neutral-500 dark:border-neutral-800 dark:text-neutral-400" : on ? "cursor-pointer border-sky-400 bg-sky-50 dark:border-sky-700 dark:bg-sky-950/40" : "cursor-pointer border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"}`;

export interface GiveFormProps {
  c: SharedConnectionView;
  screen: Pick<SharedConnectionsScreen, "brands" | "organisation" | "chat">;
  /** Give a brand a part, or change the part of `brandId`. */
  mode: "give" | "change";
  brandId: string | null;
  partId: string | null;
  /** What the connection can see now; null while it loads. */
  accounts: OrganisationAccount[] | null;
  loadError: string | null;
  members: boolean;
  vizzy: boolean;
  busy: boolean;
  error: string | null;
  onBrand: (id: string) => void;
  onPart: (id: string) => void;
  onMembers: (on: boolean) => void;
  onVizzy: (on: boolean) => void;
}

/** The give or change dialog's body as it looks for a given state, so the tests can read every state without a browser. */
export function GiveForm(p: GiveFormProps) {
  const unit = partUnit(p.c.connectorId);
  const org = p.screen.organisation.name;
  const brands = brandOptionsFor(p.c, p.screen.brands);
  const brand = p.brandId ? p.screen.brands.find((b) => b.id === p.brandId) ?? null : null;
  const options = p.accounts ? accountOptionsFor(p.c, p.accounts, p.screen.brands, p.brandId, org, { changing: p.mode === "change" ? p.partId ?? undefined : undefined }) : [];
  return (
    <>
      {p.mode === "give" ? (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-semibold">{GIVE_COPY.brand}</legend>
          {brands.map((b) => (
            <label key={b.id} className={OPTION(b.id === p.brandId, b.off)}>
              <input type="radio" name="give-brand" value={b.id} checked={b.id === p.brandId} disabled={b.off} onChange={() => p.onBrand(b.id)} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block">{b.name}</span>
                {b.note ? <span className={`mt-0.5 block ${HINT}`}>{b.note}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold">{unitOf(p.c.connectorId)}</legend>
        {!p.c.mine ? (
          <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">{notSignerDialogWords(unit.many)}</p>
        ) : (
          <>
            <p className={HINT}>{p.c.method === "oauth_pkce" ? GIVE_COPY.listMine : GIVE_COPY.listAny}</p>
            {p.loadError ? (
              <p role="alert" className={NOTE_ERR}>
                {p.loadError}
              </p>
            ) : p.accounts === null ? (
              <p className={HINT}>{GIVE_COPY.loading}</p>
            ) : options.length === 0 ? (
              <p className={NOTE_WARN}>{GIVE_COPY.none}</p>
            ) : (
              options.map((o) => (
                <label key={o.id} className={OPTION(o.id === p.partId, o.off)}>
                  <input type="radio" name="give-part" value={o.id} checked={o.id === p.partId} disabled={o.off} onChange={() => p.onPart(o.id)} className="mt-0.5" />
                  <span className="min-w-0 break-words">
                    <span className="block">{o.label}</span>
                    {o.note ? <span className={`mt-0.5 block text-xs ${o.warn ? "text-amber-700 dark:text-amber-400" : "text-neutral-500 dark:text-neutral-400"}`}>{o.note}</span> : null}
                  </span>
                </label>
              ))
            )}
          </>
        )}
      </fieldset>
      {p.mode === "give" && brand && p.c.mine ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">{readersForWords(brand.name)}</legend>
          <p className={HINT}>{GIVE_COPY.readersHint}</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={p.members} onChange={(e) => p.onMembers(e.target.checked)} />
            <span>{GIVE_COPY.members}</span>
          </label>
          {p.screen.chat ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={p.vizzy} onChange={(e) => p.onVizzy(e.target.checked)} />
              <span>{GIVE_COPY.vizzy}</span>
            </label>
          ) : null}
        </fieldset>
      ) : null}
      {p.mode === "give" && brand && p.partId && p.c.mine ? <p className={HINT}>{readsForWords(p.c.method, unit.one, brand.name)}</p> : null}
      {p.mode === "change" && brand ? (
        <p className="text-sm text-neutral-700 dark:text-neutral-300">{changeTextWords(brand.name, partWords(p.c.parts.find((x) => x.tenantId === brand.id)?.account ?? "", p.c.parts.find((x) => x.tenantId === brand.id)?.record?.label), unit.one)}</p>
      ) : null}
      {p.error ? (
        <p role="alert" className={NOTE_ERR}>
          {p.error}
        </p>
      ) : null}
    </>
  );
}

/**
 * Give a brand a part, or change a brand's part, of one of the organisation's connections. Lists
 * what the connection can see now (only its signer, for a Google sign in), marks what is given,
 * what overlaps another brand's site, and what isn't on the receiving brand's own site, and sends
 * the brand, the part and the readers to the server, which checks everything again.
 */
export function GivePartDialog({
  c,
  screen,
  mode,
  brandId: forBrand,
  onClose,
  onDone,
}: {
  c: SharedConnectionView;
  screen: SharedConnectionsScreen;
  mode: "give" | "change";
  /** The brand whose part changes; the dialog picks one to give to. */
  brandId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const unit = partUnit(c.connectorId);
  const pickable = brandOptionsFor(c, screen.brands).filter((b) => !b.off);
  const [brandId, setBrandId] = useState<string | null>(mode === "change" ? forBrand : (pickable[0]?.id ?? null));
  const current = mode === "change" ? (c.parts.find((x) => x.tenantId === forBrand)?.account ?? null) : null;
  const [partId, setPartId] = useState<string | null>(current);
  const [accounts, setAccounts] = useState<OrganisationAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [members, setMembers] = useState(true);
  const [vizzy, setVizzy] = useState(screen.chat);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!c.mine) return;
    let alive = true;
    callApi<{ accounts: OrganisationAccount[] }>(ORG_ROUTES.accounts(c.id)).then((r) => {
      if (!alive) return;
      if (r.ok) setAccounts(r.data.accounts);
      else setLoadError(r.message);
    });
    return () => {
      alive = false;
    };
  }, [c.id, c.mine]);

  const brand = brandId ? screen.brands.find((b) => b.id === brandId) ?? null : null;
  const options = useMemo(
    () => (accounts ? accountOptionsFor(c, accounts, screen.brands, brandId, screen.organisation.name, { changing: mode === "change" ? (current ?? undefined) : undefined }) : []),
    [accounts, brandId, c, current, mode, screen.brands, screen.organisation.name],
  );
  // A new brand, or the list arriving, starts on the part on that brand's own site.
  useEffect(() => {
    if (!accounts || mode === "change") return;
    setPartId(firstPartFor(options, accounts, brand?.rootDomain ?? null));
  }, [accounts, brand?.rootDomain, mode, options]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!brandId || !partId) return;
    setBusy(true);
    setError(null);
    const label = accounts?.find((a) => a.id === partId)?.label;
    const r =
      mode === "give"
        ? await callApi(ORG_ROUTES.parts(c.id), { method: "POST", body: { tenantId: brandId, account: partId, ...(label ? { label: label.slice(0, 200) } : {}), members, vizzy: screen.chat && vizzy } })
        : await callApi(ORG_ROUTES.parts(c.id), { method: "PUT", body: { tenantId: brandId, account: partId, ...(label ? { label: label.slice(0, 200) } : {}) } });
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    onDone();
  }

  const title = mode === "give" ? giveTitleWords(unit.one) : changeTitleWords(brand?.name ?? "", unit.one);
  const chosenOff = options.find((o) => o.id === partId)?.off ?? false;
  const can = Boolean(c.mine && brandId && partId && !chosenOff && !busy && (mode === "give" || partId !== current));
  return (
    <DialogFrame
      open
      onClose={onClose}
      title={title}
      about={<ConnectionAbout c={c} org={screen.organisation.name} />}
      footer={
        <>
          <button type="submit" form="give-part-form" className={BUTTON_PRIMARY} disabled={!can}>
            {busy ? GIVE_COPY.working : mode === "give" ? giveButtonWords(brand?.name ?? null) : changeButtonWords(unit.one)}
          </button>
          <button type="button" className={BUTTON} onClick={onClose}>
            {GIVE_COPY.cancel}
          </button>
        </>
      }
    >
      <form id="give-part-form" className="space-y-4" onSubmit={submit}>
        <GiveForm
          c={c}
          screen={screen}
          mode={mode}
          brandId={brandId}
          partId={partId}
          accounts={accounts}
          loadError={loadError}
          members={members}
          vizzy={vizzy}
          busy={busy}
          error={error}
          onBrand={(id) => {
            setBrandId(id);
            setError(null);
          }}
          onPart={(id) => {
            setPartId(id);
            setError(null);
          }}
          onMembers={setMembers}
          onVizzy={setVizzy}
        />
      </form>
    </DialogFrame>
  );
}
