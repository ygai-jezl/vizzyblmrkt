import type { Tile } from "@/lib/nav/homeTiles";

/** Small shared pieces for the Insights pages (server-safe). */

export function Tiles({ tiles }: { tiles: Tile[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <p className="text-xs text-neutral-500">{t.label}</p>
          <p className="mt-0.5 text-2xl font-semibold tabular-nums">{t.value}</p>
          <p className="text-xs text-neutral-500">{t.hint}</p>
        </div>
      ))}
    </div>
  );
}

export function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note ? <span className="text-xs text-neutral-500">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

export const pct = (rate: number | null | undefined) => (rate == null ? "—" : `${Math.round(rate * 100)}%`);

/** Roadmap areas show here as a quiet card instead of "Coming soon" sidebar links. */
export function RoadmapCard() {
  return (
    <Card title="On the roadmap">
      <p className="text-sm text-neutral-500">
        Market intelligence, scenario planning and company enrichment will appear here as tabs when they ship.
      </p>
    </Card>
  );
}
