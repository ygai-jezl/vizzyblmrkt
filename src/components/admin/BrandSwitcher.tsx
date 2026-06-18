"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { BrandFavicon } from "./BrandFavicon";

export interface BrandOption {
  tenantId: string;
  name: string;
  faviconUrl?: string;
  active: boolean;
}

/**
 * Brand (tenant) switcher in the sidebar header. Mirrors ModelSelector's custom
 * dropdown (no UI lib): click-outside + Escape to close, role=listbox/option.
 * Selecting a brand POSTs to the switch endpoint and refreshes so every server
 * component re-renders scoped to the new tenant; "+ Add Brand" routes to the
 * create-brand page. Replaces only the brand mark in the header — the sidebar
 * collapse toggle is a separate sibling control.
 */
export function BrandSwitcher({
  brands,
  collapsed,
}: {
  brands: BrandOption[];
  collapsed: boolean;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const active = brands.find((b) => b.active) ?? brands[0];

  useEffect(() => {
    if (!isOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [isOpen]);

  async function handleSelect(tenantId: string) {
    if (switching) return;
    if (tenantId === active?.tenantId) {
      setIsOpen(false); // already active → no-op
      return;
    }
    setSwitching(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/tenants/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId }),
      });
      if (res.ok) {
        setIsOpen(false);
        // Land on the dashboard, NOT the current URL: tenant-scoped deep routes
        // (e.g. /admin/launches/<id>) don't exist in the brand we just switched
        // into and would 404. replace() (not push) avoids leaving that now-stale
        // URL in history; refresh() re-renders /admin under the new tenant.
        router.replace("/admin");
        router.refresh();
        return;
      }
      // Brand may have been suspended/removed or membership revoked since the
      // list was built — keep the menu open and tell the user.
      setError("Couldn't switch brand. Please try again.");
    } catch {
      setError("Couldn't switch brand. Please try again.");
    } finally {
      setSwitching(false);
    }
  }

  function handleAddBrand() {
    setIsOpen(false);
    router.push("/admin/brands/new");
  }

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => {
          setError(null);
          setIsOpen((v) => !v);
        }}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        title={collapsed ? active?.name : undefined}
        disabled={switching}
        className={`flex items-center gap-2 rounded-md py-1 text-left transition-colors hover:bg-neutral-100 disabled:opacity-60 dark:hover:bg-neutral-800 ${
          collapsed ? "justify-center px-1" : "max-w-full px-1.5"
        }`}
      >
        <BrandFavicon name={active?.name ?? "?"} faviconUrl={active?.faviconUrl} />
        {!collapsed && (
          <>
            <span className="min-w-0 truncate text-sm font-semibold">
              {active?.name ?? "Select brand"}
            </span>
            <ChevronsUpDown size={14} className="shrink-0 text-neutral-400" />
          </>
        )}
      </button>

      {isOpen ? (
        <div
          role="listbox"
          className="absolute left-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-xl border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
        >
          <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Switch Brand
          </p>
          {brands.map((b) => (
            <button
              key={b.tenantId}
              type="button"
              role="option"
              aria-selected={b.active}
              onClick={() => handleSelect(b.tenantId)}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <BrandFavicon name={b.name} faviconUrl={b.faviconUrl} size={18} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{b.name}</span>
              {b.active ? (
                <Check
                  size={16}
                  className="shrink-0 text-neutral-900 dark:text-neutral-100"
                />
              ) : null}
            </button>
          ))}
          <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
          <button
            type="button"
            onClick={handleAddBrand}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <Plus size={16} className="shrink-0" />
            <span>Add Brand</span>
          </button>
          {error ? (
            <p className="px-3 py-1.5 text-xs text-red-600 dark:text-red-400">{error}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
