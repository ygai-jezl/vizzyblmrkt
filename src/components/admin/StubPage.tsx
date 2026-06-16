/**
 * A titled placeholder for a planned module that isn't built yet. Server-safe
 * (no client hooks). Matches the existing dashed-border "empty" card style used
 * across the admin pages (see settings/page.tsx, SignupsTable).
 */
export function StubPage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="rounded-md border border-dashed border-neutral-300 p-8 dark:border-neutral-700">
        <p className="text-sm text-neutral-500">{description}</p>
        <p className="mt-3 text-xs uppercase tracking-wide text-neutral-400">
          Coming soon
        </p>
      </div>
    </div>
  );
}
