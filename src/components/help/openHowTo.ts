/**
 * Opens the How to drawer at a help page, e.g. "/help/email-sending#domain".
 * Returns false when no drawer is listening (the setup guide is off), so a link
 * can carry on to the page itself.
 */
export const HOW_TO_EVENT = "yg:how-to";

let listening = 0;

export function listenForHowTo(open: (path: string) => void): () => void {
  const handler = (e: Event) => open((e as CustomEvent<string>).detail);
  window.addEventListener(HOW_TO_EVENT, handler);
  listening += 1;
  return () => {
    window.removeEventListener(HOW_TO_EVENT, handler);
    listening -= 1;
  };
}

export function openHowTo(path: string): boolean {
  if (typeof window === "undefined" || listening === 0) return false;
  window.dispatchEvent(new CustomEvent(HOW_TO_EVENT, { detail: path }));
  return true;
}
