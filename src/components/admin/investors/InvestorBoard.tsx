"use client";

import { ClipboardPaste } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { personHref } from "@/lib/audience/paths";
import { boardStageHint, PASTE_WORDS } from "@/lib/crm/paste/words";
import { dueReasons, dueTallies } from "@/lib/raise/pipeline/due";
import { BOARD_WORDS } from "@/lib/raise/pipeline/words";
import { HowToLink } from "@/components/help/HowToLink";
import { Banner } from "../connect/ui";
import { PassReasonDialog } from "./PassReasonDialog";
import { boardErrorText, loadBoard, moveCard, type BoardAnswer, type BoardCard, type BoardColumn } from "./investorsApi";

/**
 * People › Investors (or Funding), the board (RAISE_PIPELINE_ENABLED): one column per Stage in the
 * field's order, each with its count and its most recently active people, and a trailing "No longer
 * in use" column while archived stages still hold people. Everyone on the team reads it. Admins move
 * a card by dragging it onto a column or with its Move to menu (keyboard and touch): a disclosure
 * of one button a stage, so only a press moves a card, never an arrow key on a closed select (which
 * Windows browsers treat as a pick). Moving onto Passed asks why first. A move shows at once, then the card as the server saved it; a board that
 * changed meanwhile reloads. Words: src/lib/raise/pipeline/words.ts.
 */

/** "31 investors, 5 quiet for 14 days, 2 past their next step date". Pure. */
export function countsLine(b: Pick<BoardAnswer, "kind" | "totals" | "quietAfterDays">): string {
  return BOARD_WORDS.counts(b.kind, b.totals.people, b.totals.quiet, b.totals.nextStepPast, b.quietAfterDays);
}

export interface CardLines {
  title: string;
  firm: string | null;
  tier: string | null;
  /** "Next step 3 Dec 2026", or "Next step was 3 Dec 2026" once past; `warn` while it is due a follow-up. */
  nextStep: { text: string; warn: boolean } | null;
  quiet: string | null;
  followUp: boolean;
  passReason: string | null;
}

/** What one card says. Pure. */
export function cardLines(card: BoardCard, today: string): CardLines {
  const past = !!card.nextStepDate && card.nextStepDate < today;
  return {
    title: card.name ?? card.email ?? "Unnamed person",
    firm: card.firm,
    tier: card.tier ? BOARD_WORDS.tier(card.tier) : null,
    nextStep: card.nextStepDate
      ? { text: past ? BOARD_WORDS.nextStepWas(card.nextStepDate) : BOARD_WORDS.nextStep(card.nextStepDate), warn: card.due.includes("next_step") }
      : null,
    quiet: card.due.includes("quiet") && card.quietDays !== null ? BOARD_WORDS.quietFor(card.quietDays) : null,
    followUp: card.followUp,
    passReason: card.passReason?.label ?? null,
  };
}

const isLive = (c: Pick<BoardColumn, "role">) => c.role !== "archived";

/** Where a card can be moved: every stage in use but its own, in the field's order. Pure. */
export function moveTargets(columns: readonly BoardColumn[], card: Pick<BoardCard, "stageOptionId">): BoardColumn[] {
  return columns.filter((c) => isLive(c) && c.optionId !== card.stageOptionId);
}

/** Soonest Next step date first and none last, as the server sorts; a card placed among equals goes first. */
function insertCard(cards: readonly BoardCard[], card: BoardCard): BoardCard[] {
  const d = card.nextStepDate;
  const i = cards.findIndex((c) => (d ? !c.nextStepDate || c.nextStepDate >= d : !c.nextStepDate));
  return i < 0 ? [...cards, card] : [...cards.slice(0, i), card, ...cards.slice(i)];
}

/**
 * The board with one card in its place: taken out of whichever column held it and put in the
 * column for its stage (the trailing one for a stage no longer in use; none when it has no stage),
 * with the counts and the header's totals worked out again. Pure.
 */
export function placeCard(board: BoardAnswer, card: BoardCard): BoardAnswer {
  const target =
    board.columns.find((c) => isLive(c) && c.optionId === card.stageOptionId) ?? (card.stageOptionId ? board.columns.find((c) => !isLive(c)) : undefined);
  const columns = board.columns.map((c) => {
    const had = c.cards.some((x) => x.id === card.id);
    const rest = had ? c.cards.filter((x) => x.id !== card.id) : c.cards;
    const count = Math.max(0, c.count - (had ? 1 : 0));
    if (c === target) return { ...c, count: count + 1, cards: insertCard(rest, card) };
    return had ? { ...c, count, cards: rest } : c;
  });
  const tallies = dueTallies(columns.flatMap((c) => c.cards));
  return {
    ...board,
    columns,
    totals: { ...board.totals, people: columns.reduce((n, c) => n + c.count, 0), quiet: tallies.quiet, nextStepPast: tallies.nextStepPast },
  };
}

/**
 * The card as a move would leave it, before the server answers: its new stage, its reason (set
 * onto Passed, cleared on leaving it) and what it is due under the new stage. Pure.
 */
export function movedCard(board: BoardAnswer, card: BoardCard, to: string, reason?: string | null): BoardCard {
  const target = board.columns.find((c) => isLive(c) && c.optionId === to);
  const was = board.columns.find((c) => c.cards.some((x) => x.id === card.id));
  const role = target && isLive(target) ? target.role : null;
  let passReason = card.passReason;
  if (role === "passed") {
    const o = reason ? board.reasonOptions.find((r) => r.optionId === reason) : undefined;
    passReason = o ? { optionId: o.optionId, key: o.key, label: o.label } : null;
  } else if (was?.role === "passed") passReason = null;
  return { ...card, stageOptionId: to, passReason, due: role && role !== "archived" ? dueReasons(card, role, board.today) : [] };
}

const menuClass =
  "mt-2 w-full cursor-pointer list-none rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950 [&::-webkit-details-marker]:hidden";
const stageButtonClass =
  "block w-full rounded px-2 py-1 text-left text-xs hover:bg-neutral-100 focus-visible:bg-neutral-100 dark:hover:bg-neutral-800 dark:focus-visible:bg-neutral-800";

/**
 * A card's Move to menu: a disclosure that opens a list of its stages, each a real button, so only
 * pressing one moves the card (Enter, Space, a click or a tap). Opening, closing or moving through
 * the list moves nothing. No hooks, so a test can call it and press its buttons.
 */
export function MoveMenu({ card, title, targets, onMove }: { card: BoardCard; title: string; targets: readonly BoardColumn[]; onMove: (card: BoardCard, to: string) => void }) {
  return (
    <details className="mt-2">
      <summary aria-label={`${BOARD_WORDS.moveTo}: ${title}`} className={menuClass}>
        {BOARD_WORDS.moveTo}
      </summary>
      <ul className="mt-1 space-y-0.5 rounded-md border border-neutral-200 bg-white p-1 dark:border-neutral-800 dark:bg-neutral-950">
        {targets.map((c) => (
          <li key={c.optionId}>
            <button
              type="button"
              className={stageButtonClass}
              onClick={(e) => {
                // Close the menu, then move: the card reloads in its new column.
                e.currentTarget.closest("details")?.removeAttribute("open");
                onMove(card, c.optionId);
              }}
            >
              {c.label}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

function CardView({
  card,
  today,
  targets,
  canMove,
  dragging,
  onMove,
  onDrag,
}: {
  card: BoardCard;
  today: string;
  targets: BoardColumn[];
  canMove: boolean;
  dragging: boolean;
  onMove?: (card: BoardCard, to: string) => void;
  onDrag: (card: BoardCard | null) => void;
}) {
  const lines = cardLines(card, today);
  return (
    <li
      draggable={canMove}
      onDragStart={
        canMove
          ? (e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", card.id);
              onDrag(card);
            }
          : undefined
      }
      onDragEnd={canMove ? () => onDrag(null) : undefined}
      className={`rounded-md border border-neutral-200 bg-white p-2.5 text-sm shadow-sm dark:border-neutral-800 dark:bg-neutral-950 ${canMove ? "cursor-grab active:cursor-grabbing" : ""} ${dragging ? "opacity-50" : ""}`}
    >
      <Link href={personHref(card.id)} draggable={false} className="block truncate font-medium hover:underline">
        {lines.title}
      </Link>
      {lines.firm ? <p className="truncate text-xs text-neutral-600 dark:text-neutral-400">{lines.firm}</p> : null}
      {lines.tier || lines.followUp ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
          {lines.tier ? <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">{lines.tier}</span> : null}
          {lines.followUp ? (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">{BOARD_WORDS.followUpChip}</span>
          ) : null}
        </p>
      ) : null}
      {lines.nextStep ? (
        <p className={`mt-1 text-xs ${lines.nextStep.warn ? "font-medium text-amber-700 dark:text-amber-400" : "text-neutral-500"}`}>{lines.nextStep.text}</p>
      ) : null}
      {lines.quiet ? <p className="text-xs text-amber-700 dark:text-amber-400">{lines.quiet}</p> : null}
      {lines.passReason ? <p className="text-xs text-neutral-500">{lines.passReason}</p> : null}
      {canMove && onMove && targets.length ? <MoveMenu card={card} title={lines.title} targets={targets} onMove={onMove} /> : null}
    </li>
  );
}

/**
 * Whether Paste a list opens Start from a public list: on an Investors board with no one on it yet.
 * That card lists investor directories, so a Funding board (loans, grants) never opens it. Pure.
 */
export function opensPublicList(b: Pick<BoardAnswer, "kind" | "totals">): boolean {
  return b.kind === "raising" && b.totals.people === 0;
}

/**
 * Paste a list beside How the board works, for admins while Paste a list is on (S2b), told whether
 * to open Start from a public list too. No hooks, so a test can press it.
 */
export function PasteButton({ openPublicList, onPaste }: { openPublicList: boolean; onPaste: (openPublicList: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPaste(openPublicList)}
      className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
    >
      <ClipboardPaste size={14} aria-hidden /> {PASTE_WORDS.button}
    </button>
  );
}

/**
 * The board as it is drawn, from one board answer. Read only without `onMove`, or when the board
 * says this user can't move people.
 */
export function BoardView({
  board,
  actions,
  error = null,
  onMove,
  onPaste,
}: {
  board: BoardAnswer;
  /** Buttons beside How the board works. */
  actions?: ReactNode;
  error?: string | null;
  onMove?: (card: BoardCard, to: string) => void;
  /** Paste a list is on for this admin: its button, told whether the board is empty. */
  onPaste?: (openPublicList: boolean) => void;
}) {
  const empty = board.totals.people === 0;
  const canMove = board.canMove && !!onMove;
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const drag = (card: BoardCard | null) => {
    setDragging(card);
    if (!card) setOver(null);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{BOARD_WORDS.guidance}</p>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{countsLine(board)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <HowToLink path={BOARD_WORDS.helpHref} className="text-sm underline underline-offset-2">
            {BOARD_WORDS.howItWorks}
          </HowToLink>
          {actions}
          {onPaste ? <PasteButton openPublicList={opensPublicList(board)} onPaste={onPaste} /> : null}
        </div>
      </div>
      {error ? <Banner tone="err">{error}</Banner> : null}
      {board.canMove ? null : <p className="text-xs text-neutral-500">{BOARD_WORDS.membersOnly}</p>}
      {board.totals.capped ? <p className="text-xs text-neutral-500">{BOARD_WORDS.capped}</p> : null}
      {empty ? (
        <div className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          <p>{BOARD_WORDS.emptyBoard}</p>
          {onPaste ? <p className="mt-1">{boardStageHint(board.fields.stage?.label ?? "Stage")}</p> : null}
        </div>
      ) : null}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {board.columns.map((col) => {
          const droppable = canMove && !!dragging && isLive(col) && col.optionId !== dragging.stageOptionId;
          return (
            <section
              key={col.optionId}
              aria-label={col.label}
              onDragOver={
                droppable
                  ? (e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (over !== col.optionId) setOver(col.optionId);
                    }
                  : undefined
              }
              onDragLeave={
                droppable
                  ? (e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
                    }
                  : undefined
              }
              onDrop={
                droppable
                  ? (e) => {
                      e.preventDefault();
                      const card = dragging;
                      drag(null);
                      if (card && onMove) onMove(card, col.optionId);
                    }
                  : undefined
              }
              className={`flex w-64 shrink-0 flex-col rounded-lg border bg-neutral-50 dark:bg-neutral-900/40 ${
                over === col.optionId ? "border-neutral-900 dark:border-white" : "border-neutral-200 dark:border-neutral-800"
              }`}
            >
              <header className="flex items-baseline justify-between gap-2 px-3 py-2">
                <h3 className={`truncate text-sm font-medium ${isLive(col) ? "" : "text-neutral-500"}`}>{col.label}</h3>
                <span className="text-xs tabular-nums text-neutral-500">{col.count.toLocaleString("en-GB")}</span>
              </header>
              <ul className="max-h-[70vh] space-y-2 overflow-y-auto px-2 pb-2">
                {col.cards.length ? (
                  col.cards.map((card) => (
                    <CardView
                      key={card.id}
                      card={card}
                      today={board.today}
                      targets={moveTargets(board.columns, card)}
                      canMove={canMove}
                      dragging={dragging?.id === card.id}
                      onMove={onMove}
                      onDrag={drag}
                    />
                  ))
                ) : (
                  <li className="px-1 py-2 text-xs text-neutral-500">{BOARD_WORDS.emptyColumn}</li>
                )}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

type Loaded = { state: "loading" } | { state: "failed" } | { state: "not_set_up" } | { state: "ready"; board: BoardAnswer };

/** The board on People: loads it, moves cards and asks why on Passed. */
export function InvestorBoard({ actions, onPaste }: { actions?: ReactNode; onPaste?: (openPublicList: boolean) => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [passing, setPassing] = useState<{ card: BoardCard; to: string } | null>(null);

  const reload = useCallback(() => {
    void loadBoard().then((r) => {
      if (!r.ok) return setLoaded({ state: "failed" });
      setLoaded(r.data.setUp ? { state: "ready", board: r.data as BoardAnswer } : { state: "not_set_up" });
    });
  }, []);
  useEffect(() => reload(), [reload]);

  // Paste a list stays on the tab while the board loads, can't load or isn't set up: the tab row's
  // own button steps aside on this tab.
  const pasteAside = (line: ReactNode) =>
    onPaste ? (
      <div className="space-y-3">
        <div className="flex justify-end">
          <PasteButton openPublicList={false} onPaste={onPaste} />
        </div>
        {line}
      </div>
    ) : (
      line
    );
  if (loaded.state === "loading") return pasteAside(<p className="text-sm text-neutral-500">{BOARD_WORDS.loading}</p>);
  if (loaded.state === "failed") return pasteAside(<Banner tone="err">{BOARD_WORDS.errors.load_failed}</Banner>);
  if (loaded.state === "not_set_up") return pasteAside(<Banner tone="info">{BOARD_WORDS.errors.not_set_up}</Banner>);
  const board = loaded.board;

  const setBoard = (next: (b: BoardAnswer) => BoardAnswer) => setLoaded((l) => (l.state === "ready" ? { state: "ready", board: next(l.board) } : l));

  async function move(card: BoardCard, to: string, reason?: string | null) {
    setError(null);
    const before = card;
    setBoard((b) => placeCard(b, movedCard(b, card, to, reason)));
    const r = await moveCard({ personId: card.id, to, from: card.stageOptionId, ...(reason !== undefined ? { reason } : {}) });
    const saved = r.data.card;
    if (r.ok && saved) return setBoard((b) => placeCard(b, saved));
    setError(boardErrorText(r.data));
    // Someone changed them meanwhile, or they are gone: show the board as it is now.
    if (r.data.error === "stale" || r.data.error === "not_found") return reload();
    setBoard((b) => placeCard(b, before));
  }

  function requestMove(card: BoardCard, to: string) {
    if (to === card.stageOptionId) return;
    const target = board.columns.find((c) => isLive(c) && c.optionId === to);
    if (!target) return;
    // Onto Passed asks why first, while the brand has a Pass reason to pick.
    if (target.role === "passed" && board.fields.passReason && board.reasonOptions.length) setPassing({ card, to });
    else void move(card, to);
  }

  return (
    <>
      <BoardView board={board} actions={actions} error={error} onMove={requestMove} onPaste={onPaste} />
      {passing ? (
        <PassReasonDialog
          options={board.reasonOptions}
          funding={board.kind === "funding"}
          onCancel={() => setPassing(null)}
          onSave={(reason) => {
            const { card, to } = passing;
            setPassing(null);
            void move(card, to, reason);
          }}
        />
      ) : null}
    </>
  );
}
