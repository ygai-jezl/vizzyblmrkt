import Link from "next/link";
import {
  LayoutTemplate,
  Hexagon,
  Palette,
  Type,
  MessageSquareQuote,
  Images,
  Component,
  Shapes,
  Sparkles,
  BarChart3,
  Plus,
  type LucideIcon,
} from "lucide-react";
import {
  BRAND_KIT_IMAGES_ROUTE,
  BRAND_KIT_VOICE_ROUTE,
  BRAND_KIT_LOGOS_ROUTE,
  isBrandVoiceUiEnabled,
  isBrandKitLogosUiEnabled,
} from "@/lib/content/brandKit";

interface Category {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Set on the one active category ("Images"). Others are placeholders. */
  href?: string;
}

/**
 * The Canva-style Brand Kit category grid. v1: only "Images" is a live link; the rest
 * are non-functional "Coming soon" cards. "Photos" is renamed to "Images" (our library
 * is AI-generated image ASSETS, not stock photos).
 */
const CATEGORIES: Category[] = [
  { key: "brand-templates", label: "Brand Templates", icon: LayoutTemplate },
  {
    key: "logos",
    label: "Logos",
    icon: Hexagon,
    href: isBrandKitLogosUiEnabled() ? BRAND_KIT_LOGOS_ROUTE : undefined,
  },
  { key: "colours", label: "Colours", icon: Palette },
  { key: "fonts", label: "Fonts", icon: Type },
  {
    key: "brand-voice",
    label: "Brand voice",
    icon: MessageSquareQuote,
    href: isBrandVoiceUiEnabled() ? BRAND_KIT_VOICE_ROUTE : undefined,
  },
  { key: "images", label: "Images", icon: Images, href: BRAND_KIT_IMAGES_ROUTE },
  { key: "components", label: "Components", icon: Component },
  { key: "graphics", label: "Graphics", icon: Shapes },
  { key: "icons", label: "Icons", icon: Sparkles },
  { key: "charts", label: "Charts", icon: BarChart3 },
];

function CategoryCard({ category }: { category: Category }) {
  const Icon = category.icon;
  const inner = (
    <>
      <div className="mb-3 grid h-24 place-items-center rounded-lg bg-neutral-50 dark:bg-neutral-900">
        <Icon
          size={30}
          className={
            category.href
              ? "text-neutral-500 transition-colors group-hover:text-neutral-900 dark:group-hover:text-neutral-100"
              : "text-neutral-300 dark:text-neutral-600"
          }
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{category.label}</span>
        {category.href ? null : (
          <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            Soon
          </span>
        )}
      </div>
    </>
  );

  if (category.href) {
    return (
      <Link
        href={category.href}
        className="group flex flex-col rounded-xl border border-neutral-200 p-3 transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:border-neutral-700 dark:hover:bg-neutral-900/50"
      >
        {inner}
      </Link>
    );
  }
  return (
    <div
      aria-disabled
      className="flex cursor-not-allowed flex-col rounded-xl border border-neutral-200 p-3 opacity-60 dark:border-neutral-800"
    >
      {inner}
    </div>
  );
}

export function CategoryGrid() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {CATEGORIES.map((c) => (
        <CategoryCard key={c.key} category={c} />
      ))}
      {/* "New category" — dashed empty-state affordance (non-functional in v1). */}
      <div
        aria-disabled
        className="flex cursor-not-allowed flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-300 p-3 text-neutral-400 opacity-70 dark:border-neutral-700"
      >
        <Plus size={24} />
        <span className="text-sm">New category</span>
      </div>
    </div>
  );
}
