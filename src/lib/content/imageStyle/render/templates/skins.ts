import { inkOn, mix, rgba } from "./shared";

/**
 * What a format borrows from the style it's made in: its ground, ink and quieter ink, and how
 * it lights the highlighted words. Drawn styles lend their own; a painted style lends a flat
 * ground from its palette (the same grounds as its swatch on Brand › Image style).
 */
export interface Skin {
  /** CSS background for the frame. */
  ground: string;
  /** A plain colour close to the ground, for scrims and gaps. */
  base: string;
  ink: string;
  muted: string;
  /** The highlighted words' colour. */
  lit: string;
  /** The type is a serif in the mockups (Data story's paper): the heading weight to use. */
  weight: number;
}

export function skinFor(styleId: string | null | undefined, accent: string): Skin {
  switch (styleId) {
    case "product_noir":
      return { ground: "radial-gradient(#26262B 0%, #09090B 70%)", base: "#09090B", ink: "#EDEDEF", muted: "#8E8E96", lit: mix(accent, "#FFFFFF", 0.35), weight: 600 };
    case "data_story":
      return { ground: "#F5F2EA", base: "#F5F2EA", ink: "#151515", muted: "#5F5A50", lit: accent, weight: 600 };
    case "type_poster": {
      const ink = inkOn(accent) === "#FFFFFF" ? "#F6F3EC" : "#111111";
      return { ground: accent, base: accent, ink, muted: rgba(ink, 0.8), lit: ink, weight: 700 };
    }
    case "split_card": {
      const panel = mix(accent, "#0A0A0A", 0.78);
      return { ground: panel, base: panel, ink: "#FFFFFF", muted: mix(accent, "#FFFFFF", 0.62), lit: mix(accent, "#FFFFFF", 0.45), weight: 600 };
    }
    case "line_art":
      return { ground: "#FBF8F3", base: "#FBF8F3", ink: "#1F1D1A", muted: "#8A847B", lit: accent, weight: 600 };
    case "illustration":
      return { ground: "#F1EADF", base: "#F1EADF", ink: "#1F2452", muted: "#5A5F86", lit: accent, weight: 700 };
    case "editorial_photo":
      return { ground: "linear-gradient(160deg, #1A1338 0%, #0B081D 100%)", base: "#0B081D", ink: "#FFFFFF", muted: "#B9B2E0", lit: mix(accent, "#FFFFFF", 0.4), weight: 600 };
    case "soft_3d":
      return { ground: "linear-gradient(135deg, #F7F2FF 0%, #E7DFFF 50%, #FFDCCB 100%)", base: "#EFE8FF", ink: "#2A2350", muted: "#615A8A", lit: accent, weight: 700 };
    case "paper_collage":
      return { ground: "#D8C6A5", base: "#D8C6A5", ink: "#1E1A14", muted: "#5A4E3A", lit: "#C2185B", weight: 700 };
    case "natural_photo":
      return { ground: "#F4F1EC", base: "#F4F1EC", ink: "#1F1D1A", muted: "#6B655B", lit: accent, weight: 600 };
    case "product_still_life":
      return { ground: mix(accent, "#FFFFFF", 0.88), base: mix(accent, "#FFFFFF", 0.88), ink: "#16141F", muted: "#5B5870", lit: accent, weight: 700 };
    case "brand_character":
      return { ground: "#FFE066", base: "#FFE066", ink: "#1E1A14", muted: "#5A4E1A", lit: accent, weight: 800 };
    case "headline_card":
    default: {
      const g1 = mix("#0B1130", accent, 0.08);
      const g3 = mix("#1A1452", accent, 0.18);
      return { ground: `linear-gradient(155deg, ${g1} 0%, ${g3} 100%)`, base: g1, ink: "#FFFFFF", muted: "#B7BCE6", lit: mix(accent, "#FFFFFF", 0.4), weight: 800 };
    }
  }
}
