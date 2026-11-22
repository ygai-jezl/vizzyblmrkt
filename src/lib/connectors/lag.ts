/** The days a stream's numbers take to settle, in words. Pure, for the screens and the help page too. */
export function lagWords(lagDays: number): string {
  if (lagDays <= 0) return "Numbers arrive within minutes.";
  if (lagDays === 1) return "A day's numbers are complete the next day.";
  return `A day's numbers are complete about ${lagDays} days later.`;
}
