/**
 * Which of the GitHub app's repositories to tick for the customer before they
 * press "Learn from repo" — so the usual case is one click:
 *   1. the repos this product was analysed from last time (still granted);
 *   2. otherwise the repo whose name matches the product's name;
 *   3. otherwise, if the app can see exactly one repo, that one.
 * GitHub's special repos (".github", "*.github.io") are never pre-ticked.
 */

const SPECIAL = /^(\.github|[^/]+\.github\.io)$/i;

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\.(ai|com|io|app|dev)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !["dev", "prod", "staging", "test", "app", "the"].includes(w));
}

export function suggestRepos(
  repos: Array<{ fullName: string; url: string }>,
  productName: string,
  previousUrls: string[],
  max = 3,
): string[] {
  const usable = repos.filter((r) => !SPECIAL.test(r.fullName.split("/")[1] ?? ""));
  const norm = (u: string) => u.toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  const previous = new Set(previousUrls.map(norm));
  const fromLastTime = usable.filter((r) => previous.has(norm(r.url))).map((r) => r.url);
  if (fromLastTime.length) return fromLastTime.slice(0, max);

  const want = words(productName);
  if (want.length) {
    const matches = usable.filter((r) => {
      const name = (r.fullName.split("/")[1] ?? "").toLowerCase();
      return want.some((w) => name === w || name.split(/[^a-z0-9]+/).includes(w));
    });
    if (matches.length) return matches.map((r) => r.url).slice(0, max);
  }
  return usable.length === 1 ? [usable[0]!.url] : [];
}
