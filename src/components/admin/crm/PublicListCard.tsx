import { PUBLIC_LIST, type PublicLink } from "@/lib/crm/paste/publicLists";

/**
 * Start from a public list (RAISE_PASTE_ENABLED): where a founder can find investors to paste, with
 * the kit's credit and a link to the original. Plain text and links out, no logos: YouGrow never
 * fetches the kit or a directory and never copies their lists. Shown folded under the Paste a list
 * box; a board can show it open on its own.
 */

const linkClass = "font-medium text-sky-700 underline underline-offset-2 hover:no-underline dark:text-sky-400";

function Out({ link }: { link: PublicLink }) {
  return (
    <a href={link.url} target="_blank" rel="noopener noreferrer" className={linkClass}>
      {link.label}
    </a>
  );
}

export function PublicListCard({ heading = true }: { heading?: boolean }) {
  return (
    <div className="space-y-3 text-sm">
      {heading ? <h4 className="font-semibold">{PUBLIC_LIST.title}</h4> : null}
      <p>{PUBLIC_LIST.body}</p>
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        {PUBLIC_LIST.credit} <Out link={PUBLIC_LIST.kit} />
      </p>
      <ol className="list-decimal space-y-0.5 pl-5">
        {PUBLIC_LIST.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className="text-xs text-neutral-500">{PUBLIC_LIST.firms}</p>
      <div className="space-y-1">
        <p className="font-medium">{PUBLIC_LIST.othersTitle}</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {PUBLIC_LIST.others.map((o) => (
            <li key={o.url}>
              <Out link={o} />
            </li>
          ))}
        </ul>
        <p className="text-xs text-neutral-500">{PUBLIC_LIST.othersHint}</p>
      </div>
      <ul className="list-disc space-y-0.5 pl-5 text-neutral-600 dark:text-neutral-400">
        {PUBLIC_LIST.guidance.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </ul>
      <p className="text-xs text-neutral-500">{PUBLIC_LIST.footnote}</p>
    </div>
  );
}
