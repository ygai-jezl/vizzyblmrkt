import type { CSSProperties } from "react";
import {
  Activity, BookOpen, Braces, ChartLine, CircleCheck, FileText, Globe, KeyRound, Lock, Mail, MailX, MapPin,
  Megaphone, MessageCircle, MessageSquareText, Palette, PenLine, PlugZap, Rocket, ShieldCheck, Users, Webhook,
  type LucideIcon,
} from "lucide-react";
import { STAGES } from "@/lib/site/content";
import type { Translator } from "@/lib/site/i18n";
import { STACK, type StackChip, type StackIcon, type StackStage } from "@/lib/site/stack";
import { BRAND_STYLE, BrandSprite, isBrand } from "./BrandIcons";
import { ARROW } from "./icons";

const LINE: Record<string, LucideIcon> = {
  "file-text": FileText, globe: Globe, palette: Palette, braces: Braces, "plug-zap": PlugZap, webhook: Webhook,
  users: Users, megaphone: Megaphone, "book-open": BookOpen, activity: Activity, "circle-check": CircleCheck,
  "map-pin": MapPin, lock: Lock, "key-round": KeyRound, "shield-check": ShieldCheck, "mail-x": MailX, mail: Mail,
  "message-square-text": MessageSquareText, "pen-line": PenLine, rocket: Rocket, "message-circle": MessageCircle,
  "chart-line": ChartLine,
};

function Icon({ name }: { name: StackIcon }) {
  if (isBrand(name)) {
    const s = BRAND_STYLE[name];
    const style = { ...(s.tile ? { "--t": s.tile } : {}), ...(s.glyph ? { "--g": s.glyph } : {}) } as CSSProperties;
    return (
      <span className="ic br" style={style}>
        <svg aria-hidden="true"><use href={`#i-${name}`} /></svg>
      </span>
    );
  }
  const L = LINE[name];
  return <span className="ic">{L ? <L aria-hidden="true" strokeWidth={1.9} /> : null}</span>;
}

function Chips({ items, t }: { items: StackChip[]; t: Translator["t"] }) {
  return (
    <div className="stk-chips">
      {items.map((c) => (
        <span
          key={c.label}
          className={`sk${c.soon ? " next" : ""}${c.logoOnly ? " solo" : ""}`}
          title={c.logoOnly ? t(c.label) : undefined}
        >
          <Icon name={c.icon} />
          <span className={c.logoOnly ? "vh" : undefined}>{t(c.label)}</span>
          {c.soon ? <small>{t("soon")}</small> : null}
        </span>
      ))}
    </div>
  );
}

const Arrow = () => <span className="stk-arr" aria-hidden="true">{ARROW}</span>;

function Column({ n, title, stages, t }: { n: number; title: string; stages: StackStage[]; t: Translator["t"] }) {
  return (
    <div className="stk-col">
      <div className="stk-h"><i>{n}</i>{title}</div>
      {stages.map((s) => (
        <div key={s.id} className="stk-row" style={{ "--c": s.color } as CSSProperties}>
          <Icon name={s.icon} />
          <b>{t(STAGES[s.id].name)}</b>
          <span>{t(s.sub)}</span>
        </div>
      ))}
    </div>
  );
}

/** "The stack": everything the loop runs on, in one centred diagram. */
export function StackSection({ t }: { t: Translator["t"] }) {
  const S = STACK;
  return (
    <section className="sec stack" id="stack">
      <BrandSprite />
      <div className="sec-head"><h2>{t("The stack")}</h2><span className="aside">{t("Everything the loop runs on")}</span></div>
      <p className="lede"><b>{t("Everything in one place.")}</b> {t("What it learns from, the agents at every stage, where the work goes out, and what keeps you in charge.")}</p>
      <div className="stk-all">
        <div className="stk-top">
          <div className="stk-box"><span className="stk-k">{t("Learns from")}</span><Chips items={S.learnsFrom} t={t} /></div>
          <div className="stk-box"><span className="stk-k">{t("Your product connects through")}</span><Chips items={S.connectsThrough} t={t} /></div>
        </div>
        <div className="stk-frame">
          <div className="stk-flow">
            <div className="stk-end"><Icon name={S.team.icon} /><b>{t(S.team.title)}</b><span>{t(S.team.sub)}</span></div>
            <Arrow />
            <Column n={1} title={t("Make")} stages={S.make} t={t} />
            <Arrow />
            <div className="stk-gate"><span className="glyph diamond" /><b>{t(S.gate.title)}</b><span>{t(S.gate.sub)}</span></div>
            <Arrow />
            <Column n={2} title={t("Grow")} stages={S.grow} t={t} />
            <Arrow />
            <div className="stk-end"><Icon name={S.audience.icon} /><b>{t(S.audience.title)}</b><span>{t(S.audience.sub)}</span></div>
          </div>
          <div className="stk-mem"><span className="stk-k">{t("Growth memory")}</span><Chips items={S.memory} t={t} /></div>
        </div>
        <div className="stk-box wide"><span className="stk-k">{t("You stay in charge")}</span><Chips items={S.inCharge} t={t} /></div>
        <div className="stk-box wide"><span className="stk-k">{t("Connects to")}</span><Chips items={S.connectsTo} t={t} /></div>
      </div>
    </section>
  );
}
