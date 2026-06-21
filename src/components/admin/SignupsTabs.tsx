import Link from "next/link";

/**
 * Active | Offboarded switcher for the signups views. Offboarded users are
 * retained (still in the CRM) — this just keeps the active list clean (PRD §4.2).
 */
export function SignupsTabs({
  base,
  active,
}: {
  base: string;
  active: "active" | "offboarded";
}) {
  const tabs = [
    { key: "active", label: "Active", href: base },
    { key: "offboarded", label: "Offboarded", href: `${base}?status=offboarded` },
  ] as const;
  return (
    <div className="flex gap-2 text-sm">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`rounded-md border px-3 py-1 ${
            active === t.key
              ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
              : "border-neutral-300 dark:border-neutral-700"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
