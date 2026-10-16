import type { Metadata } from "next";
import { helpPage } from "./pages";

/** A help page's title and description, from the registry. */
export function helpMetadata(slug: string): Metadata {
  const p = helpPage(slug);
  if (!p) return { title: "Help · YouGrow" };
  return { title: slug ? `${p.label} · YouGrow Help` : "Get set up · YouGrow Help", description: p.summary };
}
