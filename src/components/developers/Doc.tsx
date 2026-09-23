import type { ReactNode } from "react";

/** Small, consistent building blocks for the developer docs. */

export function H1({ children }: { children: ReactNode }) {
  return <h1 className="text-2xl font-semibold tracking-tight">{children}</h1>;
}

export function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="mt-10 scroll-mt-20 text-lg font-semibold">
      <a href={`#${id}`} className="hover:underline">
        {children}
      </a>
    </h2>
  );
}

export function H3({ children }: { children: ReactNode }) {
  return <h3 className="mt-6 text-base font-semibold">{children}</h3>;
}

export function P({ children }: { children: ReactNode }) {
  return <p className="mt-3 leading-7 text-neutral-700 dark:text-neutral-300">{children}</p>;
}

export function Lead({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-lg leading-8 text-neutral-600 dark:text-neutral-400">{children}</p>;
}

export function C({ children }: { children: ReactNode }) {
  return <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-neutral-800">{children}</code>;
}

export function Code({ children, title }: { children: string; title?: string }) {
  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      {title ? <div className="border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">{title}</div> : null}
      <pre className="overflow-x-auto bg-neutral-50 p-4 font-mono text-xs leading-6 dark:bg-neutral-950">{children}</pre>
    </div>
  );
}

export function UL({ children }: { children: ReactNode }) {
  return <ul className="mt-3 list-disc space-y-1.5 pl-6 leading-7 text-neutral-700 dark:text-neutral-300">{children}</ul>;
}

export function OL({ children }: { children: ReactNode }) {
  return <ol className="mt-3 list-decimal space-y-1.5 pl-6 leading-7 text-neutral-700 dark:text-neutral-300">{children}</ol>;
}

export function Note({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  const cls =
    tone === "warn"
      ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      : "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200";
  return <div className={`mt-4 rounded-lg border px-4 py-3 text-sm leading-6 ${cls}`}>{children}</div>;
}

/** A field reference table: [name, type, notes]. */
export function Fields({ rows }: { rows: Array<[string, string, ReactNode]> }) {
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-neutral-50 text-xs uppercase text-neutral-500 dark:bg-neutral-900">
          <tr>
            <th className="px-3 py-2 font-medium">Field</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {rows.map(([name, type, notes]) => (
            <tr key={name} className="align-top">
              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{name}</td>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-neutral-500">{type}</td>
              <td className="px-3 py-2 leading-6 text-neutral-700 dark:text-neutral-300">{notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
