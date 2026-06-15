export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6 py-16">
      <p className="text-sm font-medium uppercase tracking-widest text-neutral-500">
        vizzybl-marketing
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">
        Phase 0 — Foundations
      </h1>
      <p className="text-neutral-600 dark:text-neutral-400">
        Multi-tenant sales &amp; marketing platform. The Waitlist MVP is under
        construction. Tenant-isolation layer, schema-aligned data model, and CI
        guardrails are in place; public landing pages and the admin portal land
        in Phase 1.
      </p>
      <p className="text-sm text-neutral-500">
        Health check:{" "}
        <a className="underline" href="/api/health">
          /api/health
        </a>
      </p>
    </main>
  );
}
