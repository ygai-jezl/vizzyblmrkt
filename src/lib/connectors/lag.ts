/**
 * The days a stream's numbers take to settle, in words. Pure, for the screens and the help page
 * too. "Final", not "complete": a read includes complete days whose numbers may still change, as
 * the providers' own reports do.
 */
export function lagWords(lagDays: number): string {
  if (lagDays <= 0) return "Numbers arrive within minutes.";
  if (lagDays === 1) return "A day's numbers are final the next day.";
  return `A day's numbers are final about ${lagDays} days later.`;
}
