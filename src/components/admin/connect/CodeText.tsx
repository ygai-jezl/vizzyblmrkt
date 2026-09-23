import { Fragment } from "react";

/** Plain text where `backticked` names render as code (analysis findings use them for file and function names). */
export function CodeText({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]{1,200}`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <code key={i} className="rounded bg-neutral-100 px-1 font-mono text-[0.85em] dark:bg-neutral-800">
            {p.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
