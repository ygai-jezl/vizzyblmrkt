import Link from "next/link";
import { requireAdminContext } from "@/lib/auth/session";
import { LogoutButton } from "@/components/admin/LogoutButton";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireAdminContext();

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3 dark:border-neutral-800">
        <div className="flex items-center gap-4">
          <span className="text-sm font-semibold">vizzybl-marketing</span>
          <nav className="flex gap-3 text-sm text-neutral-500">
            <Link href="/admin/signups" className="hover:text-neutral-900 dark:hover:text-neutral-100">
              Signups
            </Link>
            <span className="text-neutral-300 dark:text-neutral-700">Settings (soon)</span>
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          <span className="hidden sm:inline">
            {ctx.tenantId} · {ctx.region} · {ctx.role}
          </span>
          <LogoutButton />
        </div>
      </header>
      <main className="px-6 py-6">{children}</main>
    </div>
  );
}
