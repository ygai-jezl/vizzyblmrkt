import {
  Users,
  Megaphone,
  MousePointerClick,
  Rocket,
} from "lucide-react";

/**
 * Mock "top-level data cards" for the GTM command center dashboard. These are
 * placeholders (hardcoded values) until the unified command view is wired to
 * real analytics — they reuse the exact `Stat` shape from CampaignAnalyticsView
 * so the dashboard reads consistently once live data lands.
 */
const CARDS: Array<{
  label: string;
  value: string;
  hint?: string;
  icon: typeof Users;
}> = [
  { label: "Total signups", value: "—", hint: "across active launches", icon: Users },
  { label: "Active launches", value: "—", hint: "live waitlists", icon: Rocket },
  { label: "Broadcasts sent", value: "—", hint: "last 30 days", icon: Megaphone },
  { label: "Avg. click rate", value: "—", hint: "last 30 days", icon: MousePointerClick },
];

export function DashboardCards() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {CARDS.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.label}
            className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-wide text-neutral-500">
                {card.label}
              </div>
              <Icon size={16} className="text-neutral-400" />
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {card.value}
            </div>
            {card.hint ? (
              <div className="text-xs text-neutral-400">{card.hint}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
