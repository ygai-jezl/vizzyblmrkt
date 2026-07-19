import {
  FileText,
  Globe,
  Github,
  Lock,
  Mic,
  Sparkles,
  Image as ImageIcon,
  ArrowRight,
  Palette,
} from "lucide-react";
import { VisualFrame } from "./ui";

/**
 * Faux-product visuals for the marketing homepage feature rows. Each is a
 * hand-built, dependency-free mock (inline SVG + Tailwind) in the dark Vizzybl
 * aesthetic — illustrative of a real, shipped feature, not a live screenshot.
 * Decorative only: wrapped in aria-hidden where they convey no text meaning.
 */

// ── Create canvas: hub-and-spoke node graph ──────────────────────────────────
const SPOKES: { label: string; x: number; y: number; generating?: boolean }[] = [
  { label: "Newsletter", x: 74, y: 52 },
  { label: "Blog", x: 346, y: 52 },
  { label: "LinkedIn", x: 44, y: 150 },
  { label: "X thread", x: 376, y: 150 },
  { label: "Instagram", x: 108, y: 244, generating: true },
  { label: "eBook", x: 312, y: 244 },
];

export function CanvasVisual() {
  const hub = { x: 210, y: 148 };
  return (
    <VisualFrame>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium text-brand-muted">Content canvas</span>
        <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300">
          4 / 6 generated
        </span>
      </div>
      <svg viewBox="0 0 420 296" className="h-auto w-full" aria-hidden>
        <defs>
          <linearGradient id="hubGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#6366f1" />
            <stop offset="1" stopColor="#8b5cf6" />
          </linearGradient>
        </defs>
        {/* edges */}
        {SPOKES.map((s) => (
          <line
            key={`e-${s.label}`}
            x1={hub.x}
            y1={hub.y}
            x2={s.x}
            y2={s.y}
            stroke={s.generating ? "#8b5cf6" : "#3a3a4d"}
            strokeWidth="1.5"
            strokeDasharray={s.generating ? "4 4" : undefined}
            className={s.generating ? "animate-pulse" : undefined}
          />
        ))}
        {/* spoke nodes */}
        {SPOKES.map((s) => (
          <g key={`n-${s.label}`}>
            <rect
              x={s.x - 44}
              y={s.y - 15}
              width="88"
              height="30"
              rx="8"
              fill="#1e1e28"
              stroke={s.generating ? "#8b5cf6" : "#2a2a38"}
              strokeWidth="1.25"
            />
            <text
              x={s.x}
              y={s.y + 1}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="11.5"
              fill={s.generating ? "#c4b5fd" : "#a0a0b8"}
              fontWeight="500"
            >
              {s.label}
            </text>
          </g>
        ))}
        {/* hub node */}
        <rect
          x={hub.x - 54}
          y={hub.y - 24}
          width="108"
          height="48"
          rx="12"
          fill="url(#hubGrad)"
        />
        <text
          x={hub.x}
          y={hub.y - 3}
          textAnchor="middle"
          fontSize="13"
          fontWeight="700"
          fill="#ffffff"
        >
          Hub piece
        </text>
        <text
          x={hub.x}
          y={hub.y + 13}
          textAnchor="middle"
          fontSize="10"
          fill="rgba(255,255,255,0.75)"
        >
          your big idea
        </text>
      </svg>
    </VisualFrame>
  );
}

// ── Vizzy: conversational agent transcript ───────────────────────────────────
export function VizzyChatVisual() {
  return (
    <VisualFrame>
      <div className="flex items-center gap-2.5 border-b border-brand-line pb-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 font-display text-sm font-bold text-white">
          V
        </span>
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-white">Vizzy</span>
          <span className="flex items-center gap-1.5 text-[11px] text-brand-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            AI command center
          </span>
        </div>
        <span className="ml-auto rounded-full border border-brand-line bg-brand-raised px-2.5 py-1 text-[11px] text-brand-muted">
          Thinking
        </span>
      </div>

      <div className="flex flex-col gap-3 pt-4">
        <div className="ml-auto max-w-[80%] rounded-2xl rounded-tr-sm bg-indigo-500/90 px-3.5 py-2 text-sm text-white">
          Build a 4-email welcome journey.
        </div>
        <p className="flex items-center gap-2 pl-1 text-[13px] italic text-brand-faint">
          <Sparkles size={13} className="animate-pulse text-violet-400" />
          Pulling your onboarding docs…
        </p>
        <div className="inline-flex w-fit items-center gap-2 rounded-lg border border-brand-line bg-brand-raised px-3 py-1.5 font-mono text-[12px] text-indigo-300">
          <ArrowRight size={13} />
          build_email_journey()
        </div>
        <div className="max-w-[88%] rounded-2xl rounded-tl-sm border border-brand-line bg-brand-raised px-3.5 py-2 text-sm text-brand-muted">
          Drafted a 4-step welcome journey on your canvas. Want me to A/B the
          subject lines?
          <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-indigo-400 align-middle" />
        </div>
      </div>
    </VisualFrame>
  );
}

// ── RAG: sources → grounding → cited answer ──────────────────────────────────
export function KnowledgeVisual() {
  const sources = [
    { icon: FileText, label: "Docs" },
    { icon: Globe, label: "Website" },
    { icon: Github, label: "GitHub", locked: true },
  ];
  return (
    <VisualFrame>
      <div className="grid grid-cols-3 gap-2.5">
        {sources.map(({ icon: Icon, label, locked }) => (
          <div
            key={label}
            className="flex flex-col items-center gap-1.5 rounded-lg border border-brand-line bg-brand-raised py-3"
          >
            <Icon size={18} className="text-indigo-300" />
            <span className="flex items-center gap-1 text-[11px] text-brand-muted">
              {label}
              {locked ? <Lock size={9} className="text-brand-faint" /> : null}
            </span>
          </div>
        ))}
      </div>

      <div className="my-3 flex flex-col items-center gap-2">
        <div className="h-4 w-px bg-brand-line" />
        <div className="flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1.5">
          <span className="flex gap-1">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className="h-1.5 w-1.5 rounded-full bg-indigo-400/80" />
            ))}
          </span>
          <span className="text-[11px] font-medium text-indigo-200">
            Vector search over your knowledge
          </span>
        </div>
        <div className="h-4 w-px bg-brand-line" />
      </div>

      <div className="rounded-lg border border-brand-line bg-brand-raised p-3.5">
        <p className="text-sm leading-relaxed text-brand-muted">
          &ldquo;Our SSO setup takes about{" "}
          <span className="text-white">10 minutes</span> and supports SAML &amp;
          SCIM&rdquo;
          <span className="ml-1.5 rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] text-indigo-300">
            cited: your docs
          </span>
        </p>
      </div>
    </VisualFrame>
  );
}

// ── Waitlist + voice: rank, referrals, waveform ──────────────────────────────
const WAVE = [10, 18, 28, 16, 34, 22, 40, 26, 14, 30, 20, 36, 24, 12, 28, 18];

export function WaitlistVoiceVisual() {
  return (
    <VisualFrame>
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-widest text-brand-faint">
            Your position
          </span>
          <span className="bg-gradient-to-br from-indigo-400 to-violet-400 bg-clip-text font-display text-5xl font-extrabold tabular-nums text-transparent">
            #128
          </span>
        </div>
        <span className="mb-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
          ▲ 42 spots skipped
        </span>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <div className="flex -space-x-2">
          {["#6366f1", "#8b5cf6", "#a5b4fc", "#22d3ee"].map((c, i) => (
            <span
              key={i}
              className="h-7 w-7 rounded-full border-2 border-brand-surface"
              style={{ background: c }}
            />
          ))}
        </div>
        <span className="text-sm text-brand-muted">
          +126 joined from your link
        </span>
      </div>

      <div className="mt-5 flex items-center gap-3 rounded-xl border border-brand-line bg-brand-raised px-3.5 py-3">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-gradient-to-br from-fuchsia-500 to-cyan-400 text-white">
          <Mic size={16} />
        </span>
        <div className="flex h-8 flex-1 items-center gap-[3px]">
          {WAVE.map((h, i) => (
            <span
              key={i}
              className={`w-[3px] flex-1 rounded-full bg-gradient-to-t from-indigo-500 to-violet-400 ${
                i % 4 === 0 ? "animate-pulse" : ""
              }`}
              style={{ height: `${h}px` }}
            />
          ))}
        </div>
        <span className="flex-none text-[11px] text-brand-muted">60s</span>
      </div>
    </VisualFrame>
  );
}

// ── Email builder: block layout + describe bar ───────────────────────────────
export function EmailBuilderVisual() {
  return (
    <VisualFrame>
      <div className="mb-3 flex items-center gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-brand-line bg-brand-raised px-3 py-2 text-[13px] text-brand-faint">
          <Sparkles size={13} className="text-violet-400" />
          Describe the email you want…
        </div>
        <span className="rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-[11px] font-semibold text-indigo-300">
          A/B
        </span>
      </div>

      <div className="flex flex-col gap-2.5 rounded-xl border border-brand-line bg-white/[0.02] p-4">
        {/* heading block */}
        <div className="h-3 w-2/3 rounded bg-gradient-to-r from-white/80 to-white/40" />
        {/* text lines */}
        <div className="h-2 w-full rounded bg-brand-line" />
        <div className="h-2 w-11/12 rounded bg-brand-line" />
        <div className="h-2 w-4/5 rounded bg-brand-line" />
        {/* image block */}
        <div className="mt-1 flex h-20 items-center justify-center rounded-lg border border-dashed border-brand-line bg-brand-raised text-brand-faint">
          <ImageIcon size={20} />
        </div>
        {/* button block */}
        <div className="mt-1 flex justify-center">
          <span className="rounded-lg bg-indigo-600 px-5 py-2 text-xs font-semibold text-white shadow-glow">
            Get started
          </span>
        </div>
      </div>
    </VisualFrame>
  );
}

// ── Brand Kit: PDF → extracted palette + tone ────────────────────────────────
const KIT_PALETTE = ["#0f172a", "#6366f1", "#8b5cf6", "#22d3ee", "#f8fafc"];

export function BrandKitVisual() {
  return (
    <VisualFrame>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 rounded-lg border border-brand-line bg-brand-raised px-3 py-2.5">
          <FileText size={16} className="text-rose-400" />
          <span className="text-[13px] text-brand-muted">brand-guidelines.pdf</span>
        </div>
        <ArrowRight size={16} className="flex-none text-brand-faint" />
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-indigo-300">
          <Palette size={15} />
          Brand kit
        </span>
      </div>

      <div className="mt-4 rounded-xl border border-brand-line bg-brand-raised p-4">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-widest text-brand-faint">
          Palette
        </p>
        <div className="flex gap-2">
          {KIT_PALETTE.map((c) => (
            <span
              key={c}
              className="h-9 flex-1 rounded-md border border-white/10"
              style={{ background: c }}
            />
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-4">
          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-widest text-brand-faint">
              Tone
            </p>
            <div className="flex flex-wrap gap-1.5">
              {["Confident", "Warm", "Concise"].map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-brand-line bg-brand-surface px-2.5 py-1 text-[11px] text-brand-muted"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
          <div className="text-right">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-widest text-brand-faint">
              Type
            </p>
            <span className="font-display text-2xl font-bold text-white">Aa</span>
          </div>
        </div>
      </div>
    </VisualFrame>
  );
}
