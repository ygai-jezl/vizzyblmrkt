import type { ContentNode } from "@/lib/types/contentPlan";
import { outlineArticle } from "./outline";

/**
 * What a blog article's hero is made for: its H1, else the meta title, else the node's label.
 * Client-safe, so the hero card can say when the title has changed since the hero was made.
 */
export function heroTitle(node: Pick<ContentNode, "body" | "blog" | "role">): string {
  const h1 = outlineArticle(node.body).title?.trim();
  return (h1 || node.blog?.metaTitle?.trim() || node.role).replace(/\s+/g, " ").slice(0, 200);
}
