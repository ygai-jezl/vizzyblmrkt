import type { CSSProperties } from "react";
import type { ImageStyleId } from "@/lib/types/imageStyle";

/**
 * A tiny drawing of each image style, for the pickers (Brand › Image style, the style menus).
 * Pure CSS: it only has to tell the looks apart at a glance, not render the real thing.
 */
const GROUND: Record<ImageStyleId, CSSProperties> = {
  product_noir: { background: "radial-gradient(120% 90% at 30% 0%, #26262b 0%, #09090b 70%)" },
  headline_card: { background: "linear-gradient(155deg, #0b1130 0%, #10183d 52%, #1a1452 100%)" },
  data_story: { background: "#f5f2ea" },
  type_poster: { background: "#4f3fe0" },
  illustration: { background: "#f1eadf" },
  editorial_photo: { background: "radial-gradient(ellipse at 65% 40%, #3a2a78 0%, #1a1338 50%, #0b081d 100%)" },
  soft_3d: { background: "radial-gradient(120% 120% at 20% 10%, #f7f2ff 0%, #e7dfff 45%, #ffdccb 100%)" },
  paper_collage: { background: "#d8c6a5" },
  natural_photo: { background: "linear-gradient(180deg, #cfe5f4 0%, #e3eee6 45%, #d3a978 46%, #bd8e5d 100%)" },
  product_still_life: { background: "linear-gradient(180deg, #5b4fe6 0%, #5b4fe6 64%, #6e63ea 100%)" },
  brand_character: { background: "#ffe066" },
  split_card: { background: "linear-gradient(90deg, #c9debb 0%, #c9debb 52%, #1c1740 52%)" },
  line_art: { background: "#fbf8f3" },
};

function Shape({ id }: { id: ImageStyleId }) {
  const abs = "absolute";
  switch (id) {
    case "product_noir":
      return <span className={`${abs} right-[10%] top-[22%] h-[56%] w-[46%] rounded-[3px] border border-white/15 bg-[#141417]`} />;
    case "headline_card":
      return (
        <>
          <span className={`${abs} left-[10%] top-[26%] h-[10%] w-[60%] rounded-sm bg-[#b7bce6]`} />
          <span className={`${abs} left-[10%] top-[44%] h-[12%] w-[40%] rounded-sm bg-[#5b4fe6]`} />
          <span className={`${abs} left-[10%] top-[66%] h-[14%] w-[78%] rounded-sm border border-white/15 bg-white/5`} />
        </>
      );
    case "data_story":
      return (
        <svg className={`${abs} inset-0 h-full w-full`} viewBox="0 0 100 56" aria-hidden="true">
          <path d="M8 46 H34 L70 12 L74 46 H92" stroke="#4b3fd6" strokeWidth="3" fill="none" />
        </svg>
      );
    case "type_poster":
      return <span className={`${abs} bottom-[8%] left-[8%] text-[22px] font-black leading-none text-[#f6f3ec]`}>19</span>;
    case "illustration":
      return (
        <>
          <span className={`${abs} left-[38%] top-[14%] h-[72%] w-[40%] rounded-full bg-[#9ed8c8]`} />
          <span className={`${abs} left-[14%] top-[40%] h-[18%] w-[56%] rounded-full border-2 border-[#1f2452] bg-white`} />
          <span className={`${abs} right-[10%] top-[30%] h-[30%] w-[16%] rounded-sm bg-[#ff7a59]`} />
        </>
      );
    case "editorial_photo":
      return <span className={`${abs} left-[50%] top-[16%] h-[70%] w-[22%] -rotate-6 rounded-md bg-[#cfc6ff] shadow-[0_0_14px_rgba(200,190,255,0.6)]`} />;
    case "soft_3d":
      return <span className={`${abs} left-[34%] top-[26%] h-[48%] w-[34%] -rotate-6 rounded-xl bg-gradient-to-br from-[#b8aeff] via-[#7c6cf6] to-[#4b3bd1] shadow-lg`} />;
    case "paper_collage":
      return (
        <>
          <span className={`${abs} right-[12%] top-[10%] h-[50%] w-[30%] rounded-full bg-[#ff48b0]/90`} />
          <span className={`${abs} left-[10%] top-[40%] h-[24%] w-[70%] -rotate-3 bg-[#f8f4ea]`} />
        </>
      );
    case "natural_photo":
      return <span className={`${abs} left-[46%] top-[30%] h-[34%] w-[34%] rounded-sm bg-[#1e1f24]`} />;
    case "product_still_life":
      return (
        <>
          <span className={`${abs} left-[38%] top-[56%] h-[30%] w-[26%] rounded-b-full bg-[#ddd8fb]`} />
          <span className={`${abs} left-[44%] top-[14%] h-[44%] w-[14%] rounded-sm bg-[#111114]`} />
        </>
      );
    case "brand_character":
      return (
        <>
          <span className={`${abs} left-[34%] top-[20%] h-[62%] w-[34%] rounded-full bg-[#6c5ce7]`} />
          <span className={`${abs} left-[42%] top-[34%] h-[20%] w-[18%] rounded-full bg-white`} />
        </>
      );
    case "split_card":
      return <span className={`${abs} right-[8%] top-[36%] h-[10%] w-[34%] rounded-sm bg-white/80`} />;
    case "line_art":
      return (
        <svg className={`${abs} inset-0 h-full w-full`} viewBox="0 0 100 56" aria-hidden="true">
          <rect x="16" y="20" width="68" height="14" rx="7" stroke="#5b4fe6" strokeWidth="1.5" fill="none" />
          <circle cx="60" cy="27" r="11" stroke="#5b4fe6" strokeWidth="1.5" fill="none" />
        </svg>
      );
  }
}

export function ImageStyleSwatch({ id, className = "" }: { id: ImageStyleId; className?: string }) {
  return (
    <span aria-hidden="true" className={`relative block overflow-hidden rounded-md ${className}`} style={GROUND[id]}>
      <Shape id={id} />
    </span>
  );
}
