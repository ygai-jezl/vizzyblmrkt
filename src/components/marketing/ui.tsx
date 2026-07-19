import type { ComponentType, ReactNode, SVGProps } from "react";

/**
 * Marketing homepage primitives — the Vizzybl "skin" (dark surfaces, indigo/violet
 * gradient headlines, hover-lift cards, indigo glow) reproduced with Tailwind so
 * the homepage stays dependency-free. All server components: the only motion is
 * pure-CSS hover, matching the Vizzybl reference (no animation library). Brand
 * tokens live in tailwind.config.ts as `brand-*`.
 */

type LucideIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

/**
 * The gradient "YouGrow.ai" wordmark, shared by the header (linked, larger) and
 * the footer (plain text). Single source of truth for the gradient recipe.
 */
export function Wordmark({
  href,
  size = "sm",
}: {
  href?: string;
  size?: "sm" | "lg";
}) {
  const cls = `bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text font-display font-extrabold tracking-tight text-transparent ${
    size === "lg" ? "text-lg" : "text-base"
  }`;
  return href ? (
    <a
      href={href}
      className={`${cls} rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-bg`}
    >
      YouGrow.ai
    </a>
  ) : (
    <span className={cls}>YouGrow.ai</span>
  );
}

/** Layered radial-gradient page backdrop (indigo top-left, violet bottom-right). */
export function BlobBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 bg-brand-bg"
      style={{
        backgroundImage:
          "radial-gradient(circle at 15% 12%, rgba(99,102,241,0.14) 0%, transparent 45%)," +
          "radial-gradient(circle at 85% 88%, rgba(139,92,246,0.14) 0%, transparent 45%)",
      }}
    />
  );
}

export function Section({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={`mx-auto w-full max-w-6xl px-6 ${className}`}
    >
      {children}
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-400">
      {children}
    </p>
  );
}

/**
 * A display heading. Text inside `<em>` is rendered as the indigo→violet gradient
 * accent (the Vizzybl signature); everything else is plain white.
 */
export function GradientHeading({
  children,
  as: Tag = "h2",
  className = "",
}: {
  children: ReactNode;
  as?: "h1" | "h2" | "h3";
  className?: string;
}) {
  return (
    <Tag
      className={`font-display font-extrabold tracking-tight text-white [&_em]:bg-gradient-to-br [&_em]:from-indigo-400 [&_em]:to-violet-400 [&_em]:bg-clip-text [&_em]:not-italic [&_em]:text-transparent ${className}`}
    >
      {children}
    </Tag>
  );
}

/** A single capability stat — a truthful product fact, not a traction metric. */
export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="bg-gradient-to-br from-white to-brand-periwinkle bg-clip-text font-display text-3xl font-extrabold text-transparent sm:text-4xl">
        {value}
      </span>
      <span className="text-sm text-brand-muted">{label}</span>
    </div>
  );
}

/** A compact inline stat pill row, used under the hero. */
export function StatRow({
  items,
}: {
  items: { icon?: LucideIcon; label: string }[];
}) {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
      {items.map(({ icon: Icon, label }) => (
        <li key={label} className="flex items-center gap-2 text-sm text-brand-muted">
          {Icon ? <Icon size={16} className="text-indigo-400" /> : null}
          {label}
        </li>
      ))}
    </ul>
  );
}

/** Primary (solid indigo) or secondary (outline) call-to-action link. */
export function CTAButton({
  href,
  children,
  variant = "primary",
  external = false,
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary";
  external?: boolean;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-6 py-3 text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-bg";
  const styles =
    variant === "primary"
      ? "bg-indigo-600 text-white shadow-glow hover:-translate-y-0.5 hover:bg-indigo-700"
      : "border border-brand-line bg-white/[0.02] text-white hover:-translate-y-0.5 hover:border-indigo-500/60 hover:bg-white/[0.05]";
  const props = external
    ? { target: "_blank", rel: "noopener noreferrer" }
    : {};
  return (
    <a href={href} className={`${base} ${styles}`} {...props}>
      {children}
    </a>
  );
}

/** The dark card frame that houses a faux-product visual. */
export function VisualFrame({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    // The visuals are decorative product mockups; their inner mock text would
    // otherwise be announced as confusing, out-of-context content. Hidden from
    // assistive tech here in one place (no visual has focusable descendants).
    <div
      aria-hidden
      className={`relative overflow-hidden rounded-2xl border border-brand-line bg-brand-surface p-5 shadow-glow-soft ${className}`}
    >
      {/* soft inner top-light so the panel reads as glass, like the Vizzybl cards */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white/[0.06] to-transparent"
      />
      <div className="relative">{children}</div>
    </div>
  );
}

/**
 * An alternating feature row: copy on one side, a visual on the other. Set
 * `reverse` to flip which side the visual sits on (odd/even rows).
 */
export function FeatureRow({
  id,
  eyebrow,
  heading,
  body,
  bullets,
  visual,
  reverse = false,
}: {
  id?: string;
  eyebrow: string;
  heading: ReactNode;
  body: ReactNode;
  bullets?: string[];
  visual: ReactNode;
  reverse?: boolean;
}) {
  return (
    <Section id={id} className="py-16 sm:py-24">
      <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <div className={`flex flex-col gap-5 ${reverse ? "lg:order-2" : ""}`}>
          <Eyebrow>{eyebrow}</Eyebrow>
          <GradientHeading className="text-3xl sm:text-4xl">
            {heading}
          </GradientHeading>
          <p className="text-lg leading-relaxed text-brand-muted">{body}</p>
          {bullets && bullets.length > 0 ? (
            <ul className="flex flex-col gap-2.5">
              {bullets.map((b) => (
                <li key={b} className="flex items-start gap-2.5 text-brand-muted">
                  <CheckDot />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className={reverse ? "lg:order-1" : ""}>{visual}</div>
      </div>
    </Section>
  );
}

function CheckDot() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="mt-0.5 h-5 w-5 flex-none text-indigo-400"
      fill="none"
      aria-hidden
    >
      <circle cx="10" cy="10" r="9" className="fill-indigo-500/10" />
      <path
        d="M6 10.5l2.5 2.5L14 7.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A bento-grid feature card (icon + title + body) with the Vizzybl hover-lift. */
export function FeatureCard({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="group flex flex-col gap-3 rounded-xl border border-brand-line bg-brand-surface p-6 transition-all duration-200 hover:-translate-y-1 hover:border-indigo-500/60 hover:shadow-glow">
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-brand-line bg-brand-raised text-indigo-400 transition-colors group-hover:border-indigo-500/50 group-hover:text-indigo-300">
        <Icon size={20} />
      </span>
      <h3 className="font-display text-lg font-semibold text-white">{title}</h3>
      <p className="text-sm leading-relaxed text-brand-muted">{children}</p>
    </div>
  );
}
