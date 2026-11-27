import type { CardStepView, CardView } from "./view";

/**
 * The order Home draws a card in, as the approved mockups do (Home, After an action is done): the
 * note from the card before and the steps already done or answered come first, drawn as done notes,
 * then the open steps, numbered on from them; each done note counts in "1 of 4 done". Pure, with no
 * imports beyond types, so the card on the page runs it again after each press.
 */
export function arrangeCard(view: Pick<CardView, "cardId" | "note"> & { steps: readonly CardStepView[] }): CardView {
  const lead = view.note ? 1 : 0;
  const decided = view.steps.filter((s) => s.state !== "open");
  const open = view.steps.filter((s) => s.state === "open");
  const steps = [...decided, ...open].map((s, i) => ({ ...s, n: lead + i + 1 }));
  return { cardId: view.cardId, note: view.note, steps, done: lead + decided.length, total: lead + steps.length };
}

/** The card with one step changed (or left out, when `change` gives null), arranged again. */
export function withStep(view: CardView, key: string, change: (s: CardStepView) => CardStepView | null): CardView {
  const steps = view.steps.flatMap((s) => {
    if (s.key !== key) return [s];
    const next = change(s);
    return next ? [next] : [];
  });
  return arrangeCard({ ...view, steps });
}
