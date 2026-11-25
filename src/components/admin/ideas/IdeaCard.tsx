"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IDEA_LIMITS, type Idea, type IdeaStatus } from "@/lib/types/campaign";
import type { HandoffChoices } from "@/lib/ideas/handoff";
import { handedOffLine, IDEA_STATUS_LABEL, IDEA_STATUS_OPTIONS, IDEA_STATUS_TONE, ideaErrorText, ideaMessages, JUST_A_LIST, statusLine } from "@/lib/ideas/words";
import { useWords } from "../nav/WordsProvider";
import { api } from "../connect/api";
import { Banner, Button, inputClass } from "../connect/ui";
import { Chip, chipToneClass } from "../people/Chip";

/**
 * A launch's idea on its Overview (LAUNCH_IDEAS_ENABLED): the status (saved on click, with who set
 * it and when), the hypothesis and outcome (saved with Save), and Just a list. Parked or killed
 * offers to close the waitlist; nothing closes on its own. Admins change it; everyone else reads it.
 * A launch marked Just a list shows one line instead, with Make it an idea for an admin.
 *
 * While the idea is Launched, an admin hands it off to the product it became, and can pick again to
 * change it; the line stays when the status moves on. It links to the product only while connected
 * products are on (LIFECYCLE_ENABLED).
 */

const CLOSING: readonly IdeaStatus[] = ["parked", "killed"];

export interface IdeaCardProps {
  campaignId: string;
  idea: Idea;
  canEdit: boolean;
  /** The waitlist is closed already: nothing to offer. */
  archived: boolean;
  /** The viewer's user id, so their own changes say "you". */
  viewerId: string | null;
  /** Team members' names by user id, for who set the status. */
  names: Readonly<Record<string, string>>;
  /** The products it can be handed off to, and which is picked first. */
  handoff?: HandoffChoices | null;
  /** Link the hand-off to its product's page (LIFECYCLE_ENABLED). */
  productLinks?: boolean;
}

interface IdeaReply {
  ok?: boolean;
  idea?: Idea;
  archived?: boolean | null;
  error?: string;
}

const count = (n: number) => n.toLocaleString("en-GB");

/**
 * The product the picker shows picked: the admin's own pick, else the one the idea went to, else
 * the default, as long as it is one of the options shown now. Worked out on every render, so a
 * hand-off to a product since revoked, or options that arrive after Make it an idea, never leave the
 * picker on a product it doesn't list (where Hand off would stay off and picking the one option
 * shown would change nothing).
 */
export function handoffPick(choices: HandoffChoices | null, ...wanted: Array<string | null | undefined>): string {
  const options = choices?.options ?? [];
  const listed = (id: string | null | undefined): id is string => !!id && options.some((o) => o.id === id);
  return wanted.find(listed) ?? (listed(choices?.defaultId) ? choices!.defaultId! : (options[0]?.id ?? ""));
}

export function IdeaCard({ campaignId, idea: initial, canEdit, archived, viewerId, names, handoff = null, productLinks = false }: IdeaCardProps) {
  const router = useRouter();
  const { ideas } = useWords();
  const [idea, setIdea] = useState<Idea>(initial);
  const [hyp, setHyp] = useState(initial.hypothesis ?? "");
  const [out, setOut] = useState(initial.outcome ?? "");
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState(false);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The admin's own pick in the picker, if they made one.
  const [chosen, setChosen] = useState<string | null>(null);
  const product = handoffPick(handoff, chosen, idea.productConnectionId);

  async function patch(body: Record<string, unknown>): Promise<IdeaReply | null> {
    setBusy(true);
    setError(null);
    const r = await api<IdeaReply>(`/api/admin/campaigns/${encodeURIComponent(campaignId)}/idea`, { method: "PATCH", body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok || !r.data.idea) {
      setError(ideaErrorText(r.data.error, ideas));
      return null;
    }
    setIdea(r.data.idea);
    return r.data;
  }

  async function pickStatus(status: IdeaStatus) {
    if (status === idea.status || busy) return;
    if (!(await patch({ status }))) return;
    setOffer(CLOSING.includes(status) && !archived && !closed);
    router.refresh();
  }

  async function closeWaitlist() {
    const r = await patch({ closeWaitlist: true });
    if (!r) return;
    if (r.archived) {
      setOffer(false);
      setClosed(true);
      router.refresh();
    } else {
      setError(ideaMessages(ideas).closeFailed);
    }
  }

  async function saveText() {
    const r = await patch({ hypothesis: hyp, outcome: out });
    if (!r?.idea) return;
    setHyp(r.idea.hypothesis ?? "");
    setOut(r.idea.outcome ?? "");
    setDirty(false);
    setSaved(true);
  }

  async function handOff() {
    if (product) await patch({ productConnectionId: product });
  }

  async function setList(justAList: boolean) {
    if (await patch({ justAList })) router.refresh();
  }

  if (idea.justAList) {
    return (
      <div role="note" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-neutral-300 px-4 py-3 text-sm dark:border-neutral-700">
        <p className="text-neutral-600 dark:text-neutral-400">{JUST_A_LIST}: no hypothesis or status, and it&apos;s left out of comparisons.</p>
        {canEdit ? (
          <Button onClick={() => void setList(false)} disabled={busy}>
            Make it an idea
          </Button>
        ) : null}
        {error ? <Banner tone="err">{error}</Banner> : null}
      </div>
    );
  }

  const status = idea.status;
  return (
    <section aria-labelledby="idea-card-h" className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="idea-card-h" className="text-sm font-semibold">
          Idea
        </h2>
        <p className="text-xs text-neutral-500">Admins change it. Everyone on the team can read it.</p>
      </div>

      <div className="space-y-1.5">
        <p id="idea-status-l" className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Status
        </p>
        {canEdit ? (
          <div role="radiogroup" aria-labelledby="idea-status-l" className="flex flex-wrap gap-1.5">
            {IDEA_STATUS_OPTIONS.map((o) => {
              const on = o.value === status;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={busy}
                  onClick={() => void pickStatus(o.value)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs font-medium disabled:cursor-wait ${
                    on ? `border-current ${chipToneClass(o.tone)}` : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                  }`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        ) : status ? (
          <Chip tone={IDEA_STATUS_TONE[status]}>{IDEA_STATUS_LABEL[status]}</Chip>
        ) : null}
        <p className="text-xs text-neutral-500">{statusLine(idea, viewerId, names)}</p>
      </div>

      {offer && status && CLOSING.includes(status) ? (
        <div role="status" className="space-y-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          <p>{IDEA_STATUS_LABEL[status]}. The waitlist is still open: people can still join, and its emails still go out.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setOffer(false)} disabled={busy}>
              Keep it open
            </Button>
            <Button tone="primary" onClick={() => void closeWaitlist()} disabled={busy}>
              Also close the waitlist
            </Button>
          </div>
        </div>
      ) : null}
      {closed ? <Banner tone="info">Waitlist closed. Nobody new can join and its emails are paused. It&apos;s under Archived on the list now.</Banner> : null}

      <TextPart
        label="Hypothesis"
        hint="What you expect to happen, and for whom."
        placeholder="Plant owners will pay each month for a box of care supplies."
        value={hyp}
        limit={IDEA_LIMITS.hypothesis}
        canEdit={canEdit}
        onChange={(v) => {
          setHyp(v);
          setDirty(true);
          setSaved(false);
        }}
      />
      <TextPart
        label="Outcome"
        hint="Fill this in as you learn. It stays with the idea."
        placeholder="What happened, and what you learned."
        value={out}
        limit={IDEA_LIMITS.outcome}
        canEdit={canEdit}
        onChange={(v) => {
          setOut(v);
          setDirty(true);
          setSaved(false);
        }}
      />
      {canEdit ? (
        <div className="flex items-center gap-3">
          <Button tone="primary" onClick={() => void saveText()} disabled={!dirty || busy}>
            Save
          </Button>
          {saved ? <span className="text-xs text-neutral-500">Saved by you just now.</span> : null}
        </div>
      ) : null}

      <HandOff
        idea={idea}
        canEdit={canEdit}
        busy={busy}
        choices={handoff}
        product={product}
        onProduct={setChosen}
        onHandOff={() => void handOff()}
        productLinks={productLinks}
        line={handedOffLine(idea, handoff?.names ?? {}, viewerId, names)}
      />

      {canEdit ? (
        <label className="flex items-start gap-2 border-t border-neutral-100 pt-3 text-sm dark:border-neutral-900">
          <input type="checkbox" className="mt-0.5" checked={false} disabled={busy} onChange={() => void setList(true)} />
          <span>
            <span className="block text-xs font-medium text-neutral-600 dark:text-neutral-400">{JUST_A_LIST}</span>
            <span className="block text-xs text-neutral-500">
              For a newsletter or sign up list that isn&apos;t an idea. It hides this card and leaves the list out of comparisons.
            </span>
          </span>
        </label>
      ) : null}

      {error ? <Banner tone="err">{error}</Banner> : null}
    </section>
  );
}

function TextPart({
  label,
  hint,
  placeholder,
  value,
  limit,
  canEdit,
  onChange,
}: {
  label: string;
  hint: string;
  placeholder?: string;
  value: string;
  limit: number;
  canEdit: boolean;
  onChange: (value: string) => void;
}): ReactNode {
  if (!canEdit) {
    return (
      <div className="space-y-1">
        <p className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</p>
        <p className={`whitespace-pre-wrap text-sm ${value ? "" : "text-neutral-500"}`}>{value || "None yet."}</p>
      </div>
    );
  }
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      <textarea rows={3} maxLength={limit} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={inputClass} />
      <span className="flex justify-between gap-3 text-xs text-neutral-500">
        <span>{hint}</span>
        <span className="shrink-0 tabular-nums">
          {count(value.length)} of {count(limit)}
        </span>
      </span>
    </label>
  );
}

/** Hand off to a product: the line once handed off, and while Launched the picker for an admin. */
function HandOff({
  idea,
  canEdit,
  busy,
  choices,
  product,
  onProduct,
  onHandOff,
  productLinks,
  line,
}: {
  idea: Idea;
  canEdit: boolean;
  busy: boolean;
  choices: HandoffChoices | null;
  product: string;
  onProduct: (id: string) => void;
  onHandOff: () => void;
  productLinks: boolean;
  line: string | null;
}): ReactNode {
  const launched = idea.status === "launched";
  if (!launched && !line) return null;
  const options = choices?.options ?? [];
  const handedName = idea.productConnectionId ? (choices?.names[idea.productConnectionId] ?? null) : null;
  const linked = productLinks && idea.productConnectionId && options.some((o) => o.id === idea.productConnectionId);
  const picked = options.find((o) => o.id === choices?.defaultId);
  return (
    <div className="space-y-2 border-t border-neutral-100 pt-3 dark:border-neutral-900">
      <h3 className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Hand off to a product</h3>
      {line ? (
        <p className="text-sm">
          {line}{" "}
          {linked ? (
            <Link href={`/admin/products/${idea.productConnectionId}`} className="underline underline-offset-2">
              Open {handedName}
            </Link>
          ) : null}
        </p>
      ) : null}
      {launched && canEdit ? (
        options.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Product" value={product} disabled={busy} onChange={(e) => onProduct(e.target.value)} className={`${inputClass} w-auto`}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <Button onClick={onHandOff} disabled={busy || !product || product === idea.productConnectionId}>
              Hand off
            </Button>
          </div>
        ) : (
          <p className="text-xs text-neutral-500">
            No product is connected yet. See{" "}
            <Link href="/help/connect-your-product" className="underline underline-offset-2">
              Connect your product
            </Link>
            .
          </p>
        )
      ) : null}
      {launched && canEdit && options.length ? (
        <p className="text-xs text-neutral-500">
          {line
            ? "Pick another product to change it. Each change is kept."
            : choices?.fromWave && picked
              ? `Picked first: ${picked.name}, where its latest invite wave went.`
              : "Pick the product this idea became."}
        </p>
      ) : null}
    </div>
  );
}
