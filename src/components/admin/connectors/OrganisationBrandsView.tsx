"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HowToLink } from "@/components/help/HowToLink";
import type { BringInCandidate, OrganisationBrandsScreen, OrganisationBrandView } from "@/lib/connectors/organisationBrands";
import { callApi, ORG_BRAND_ROUTES } from "./api";
import { DialogFrame, OPTION } from "./GivePartDialog";
import {
  BRANDS_COPY,
  BRANDS_HELP_PATH,
  BUTTON,
  BUTTON_PRIMARY,
  HINT,
  NOTE_ERR,
  NOTE_OK,
  NOTE_PLAIN,
  NOTE_WARN,
  brandsTableWords,
  bringInGoWords,
  bringInTextWords,
  candidateWords,
  fullWords,
  moveOutTextWords,
  moveOutTitleWords,
  moveRefusalWords,
  narrowerWords,
} from "./words";

const TH = "border-b border-neutral-200 px-3 py-2 text-left text-xs font-medium text-neutral-500 dark:border-neutral-800 dark:text-neutral-400";
const TD = "border-b border-neutral-100 px-3 py-2 align-top last:border-b-0 dark:border-neutral-900";
const CHIP = "ml-2 inline-block rounded bg-blue-50 px-1 text-xs font-normal text-blue-700 dark:bg-blue-950/50 dark:text-blue-300";
const DANGER = `${BUTTON} border-red-300 text-red-700 dark:border-red-900 dark:text-red-400`;
const SMALL = "px-2 py-1 text-xs";

/**
 * The organisation's brands as a table: name, region, the parts given to it (while sharing is on),
 * and Move out, which a brand alone in its organisation doesn't have. No hooks, so a test can draw it.
 */
export function BrandsTable({ screen, onMove, busy = false }: { screen: OrganisationBrandsScreen; onMove?: (id: string) => void; busy?: boolean }) {
  const canMove = screen.brands.length > 1;
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table aria-label={brandsTableWords(screen.organisation.name)} className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className={TH}>{BRANDS_COPY.brand}</th>
            <th className={TH}>{BRANDS_COPY.region}</th>
            {screen.sharing ? <th className={TH}>{BRANDS_COPY.parts}</th> : null}
            <th className={TH}>
              <span className="sr-only">{BRANDS_COPY.actions}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {screen.brands.map((b) => (
            <tr key={b.id}>
              <td className={`${TD} font-medium`}>
                {b.name}
                {b.isThis ? <span className={CHIP}>{BRANDS_COPY.thisBrand}</span> : null}
              </td>
              <td className={TD}>{b.regionName}</td>
              {screen.sharing ? <td className={TD}>{b.parts ? String(b.parts.length) : <span className={HINT}>{BRANDS_COPY.couldntCount}</span>}</td> : null}
              <td className={`${TD} w-px whitespace-nowrap text-right`}>
                {canMove ? (
                  <button type="button" className={`${BUTTON} ${SMALL}`} aria-haspopup="dialog" aria-label={moveOutTitleWords(b.name)} disabled={busy} onClick={() => onMove?.(b.id)}>
                    {BRANDS_COPY.moveOut}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What the Bring in dialog says for the brand picked (or none): its text, or why it can't come in. No hooks. */
export function bringInState(screen: OrganisationBrandsScreen, picked: BringInCandidate | null): { text: string | null; warn: string | null; go: boolean } {
  const org = screen.organisation;
  if (screen.full) return { text: null, warn: fullWords(org.name, screen.full.limit, org.planName), go: false };
  if (!picked) return { text: null, warn: null, go: false };
  if (picked.narrower) return { text: null, warn: narrowerWords(picked.name, picked.organisation.planName, org.planName, picked.narrower), go: false };
  return { text: bringInTextWords(picked, org.name, org.planName), warn: null, go: true };
}

/** The Bring in dialog's body: the brands you could bring in, as radio cards, then what bringing the one picked does. No hooks. */
export function BringInBody({ screen, pick, onPick, error }: { screen: OrganisationBrandsScreen; pick: string | null; onPick: (id: string) => void; error: string | null }) {
  if (!screen.candidates.length) return <p className={NOTE_PLAIN}>{BRANDS_COPY.none}</p>;
  const picked = screen.candidates.find((c) => c.id === pick) ?? null;
  const state = bringInState(screen, picked);
  return (
    <>
      {screen.full ? null : (
        <fieldset>
          <legend className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{BRANDS_COPY.brand}</legend>
          <div className="mt-2 space-y-2">
            {screen.candidates.map((c) => (
              <label key={c.id} className={OPTION(c.id === pick, false)}>
                <input type="radio" name="bring-in" value={c.id} checked={c.id === pick} onChange={() => onPick(c.id)} className="mt-0.5" />
                <span className="min-w-0 flex-1">{candidateWords(c)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {state.text ? <p className="text-sm text-neutral-700 dark:text-neutral-300">{state.text}</p> : null}
      {state.warn ? (
        <p role="status" className={NOTE_WARN}>
          {state.warn}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={NOTE_ERR}>
          {error}
        </p>
      ) : null}
    </>
  );
}

/** The Move out dialog's body: what moving it out does, or why it can't be done here. No hooks. */
export function MoveOutBody({ screen, b, error }: { screen: OrganisationBrandsScreen; b: OrganisationBrandView; error: string | null }) {
  return (
    <>
      {b.moveRefusal ? (
        <p role="status" className={NOTE_WARN}>
          {moveRefusalWords(b.name, b.moveRefusal)}
        </p>
      ) : (
        <p className="text-sm text-neutral-700 dark:text-neutral-300">{moveOutTextWords(b, screen.organisation.name, screen.organisation.planName, screen.brands, screen.sharing)}</p>
      )}
      {error ? (
        <p role="alert" className={NOTE_ERR}>
          {error}
        </p>
      ) : null}
    </>
  );
}

type Open = { kind: "bring"; pick: string | null } | { kind: "move"; tenantId: string };

/**
 * Settings › Organisation › Brands (Connectors 3 group 4, owners only): the organisation's brands
 * in every region, with the parts given to each, Bring in a brand you run, and Move out. Every
 * change goes through the routes under /api/admin/organisation/brands, which check the owners on
 * both sides and the admin row again, live.
 */
export function OrganisationBrandsView({ screen }: { screen: OrganisationBrandsScreen }) {
  const router = useRouter();
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const close = () => {
    setOpen(null);
    setError(null);
  };

  async function moveOut(b: OrganisationBrandView) {
    setBusy(true);
    setError(null);
    const r = await callApi<{ message: string }>(ORG_BRAND_ROUTES.moveOut(b.id), { method: "POST" });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setOpen(null);
    setNote({ tone: "ok", text: r.data.message });
    router.refresh();
  }

  async function bringIn() {
    if (open?.kind !== "bring" || !open.pick) return;
    setBusy(true);
    setError(null);
    const r = await callApi<{ message: string }>(ORG_BRAND_ROUTES.list, { method: "POST", body: { tenantId: open.pick } });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setOpen(null);
    setNote({ tone: "ok", text: r.data.message });
    router.refresh();
  }

  const picked = open?.kind === "bring" ? (screen.candidates.find((c) => c.id === open.pick) ?? null) : null;
  const canGo = Boolean(open?.kind === "bring" && screen.candidates.length && bringInState(screen, picked).go);
  const moving = open?.kind === "move" ? (screen.brands.find((b) => b.id === open.tenantId) ?? null) : null;
  return (
    <section aria-labelledby="org-brands-h" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <h2 id="org-brands-h" className="text-base font-semibold">
          {BRANDS_COPY.title}
        </h2>
        <button type="button" className={BUTTON} aria-haspopup="dialog" onClick={() => setOpen({ kind: "bring", pick: null })}>
          {BRANDS_COPY.bringIn}
        </button>
      </div>
      {note ? (
        <p role="status" className={note.tone === "ok" ? NOTE_OK : NOTE_ERR}>
          {note.text}
        </p>
      ) : null}
      <BrandsTable screen={screen} busy={busy} onMove={(id) => setOpen({ kind: "move", tenantId: id })} />
      <HowToLink path={BRANDS_HELP_PATH} className="inline-block text-sm font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">
        {BRANDS_COPY.help}
      </HowToLink>

      {open?.kind === "bring" ? (
        <DialogFrame
          open
          onClose={close}
          title={BRANDS_COPY.bringIn}
          about={null}
          footer={
            screen.candidates.length && !screen.full ? (
              <>
                <button type="button" className={BUTTON_PRIMARY} disabled={busy || !canGo} onClick={bringIn}>
                  {bringInGoWords(picked?.name ?? null)}
                </button>
                <button type="button" className={BUTTON} onClick={close}>
                  {BRANDS_COPY.cancel}
                </button>
              </>
            ) : (
              <button type="button" className={BUTTON} onClick={close}>
                {BRANDS_COPY.close}
              </button>
            )
          }
        >
          <BringInBody screen={screen} pick={open.pick} onPick={(id) => setOpen({ kind: "bring", pick: id })} error={error} />
        </DialogFrame>
      ) : null}
      {moving ? (
        <DialogFrame
          open
          onClose={close}
          title={moveOutTitleWords(moving.name)}
          about={null}
          footer={
            moving.moveRefusal ? (
              <button type="button" className={BUTTON} onClick={close}>
                {BRANDS_COPY.close}
              </button>
            ) : (
              <>
                <button type="button" className={DANGER} disabled={busy} onClick={() => moveOut(moving)}>
                  {moveOutTitleWords(moving.name)}
                </button>
                <button type="button" className={BUTTON} onClick={close}>
                  {BRANDS_COPY.cancel}
                </button>
              </>
            )
          }
        >
          <MoveOutBody screen={screen} b={moving} error={error} />
        </DialogFrame>
      ) : null}
    </section>
  );
}
