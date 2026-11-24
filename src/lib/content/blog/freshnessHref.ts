/** An article's canvas, opened at its Freshness card (BLOG_FRESHNESS_ENABLED). Safe in the browser. */
export const refreshHref = (a: { planId: string; workspaceId: string }) =>
  `/admin/workspace/${encodeURIComponent(a.workspaceId)}/create/${encodeURIComponent(a.planId)}?freshness=1`;
