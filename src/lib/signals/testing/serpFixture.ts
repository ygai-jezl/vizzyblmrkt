/**
 * A made-up DataForSEO "task_get/advanced" answer, shaped like the real one (organic, People also
 * ask with both kinds of expanded answer, people also search, related searches, an AI Overview),
 * with made-up sites only. For tests.
 */
export const SERP_RESULT = {
  keyword: "how do i get cited by ai answers",
  type: "organic",
  item_types: ["ai_overview", "people_also_ask", "organic", "people_also_search", "related_searches"],
  items: [
    {
      type: "ai_overview",
      rank_group: 1,
      rank_absolute: 1,
      references: [
        { type: "ai_overview_reference", source: "Rival A", domain: "rival-a.test", url: "https://rival-a.test/blog/cited", title: "Getting cited" },
        { type: "ai_overview_reference", source: "Google", domain: "www.google.com", url: "https://www.google.com/url?q=https://forum.test/t/1&sa=U", title: "A forum thread" },
      ],
      items: [{ type: "ai_overview_element", references: [{ domain: "www.brand.example.com", url: "https://www.brand.example.com/guide", title: "Our guide" }] }],
    },
    {
      type: "people_also_ask",
      rank_group: 1,
      rank_absolute: 2,
      items: [
        {
          type: "people_also_ask_element",
          title: "How does ChatGPT choose which sources to cite?",
          expanded_element: [{ type: "people_also_ask_expanded_element", url: "https://rival-b.test/how-it-chooses", domain: "rival-b.test", title: "How it chooses" }],
        },
        {
          type: "people_also_ask_element",
          title: "Does ChatGPT cite recent content more often?",
          expanded_element: [{ type: "people_also_ask_ai_overview_expanded_element", references: [{ url: "https://news.test/recent", domain: "news.test" }] }],
        },
        { type: "people_also_ask_element", title: "does chatgpt cite recent content more often?", expanded_element: null },
        { type: "people_also_ask_element", title: "What makes a page easy to quote?", expanded_element: [] },
      ],
    },
    { type: "organic", rank_group: 1, rank_absolute: 3, domain: "rival-a.test", url: "https://rival-a.test/blog/cited", title: "How to get cited by AI answers" },
    { type: "organic", rank_group: 2, rank_absolute: 4, domain: "www.forum.test", url: "https://www.forum.test/t/1", title: "Thread" },
    { type: "organic", rank_group: 3, rank_absolute: 5, domain: "blog.brand.example.com", url: "https://blog.brand.example.com/get-cited", title: "Get cited: a checklist" },
    { type: "organic", rank_group: 4, rank_absolute: 6, domain: "", url: "not a url", title: "Broken" },
    { type: "people_also_search", rank_group: 1, rank_absolute: 7, title: "People also search for", items: ["get cited by chatgpt step by step", { title: "ai citations checklist" }] },
    { type: "related_searches", rank_group: 1, rank_absolute: 8, items: ["chatgpt sources", "chatgpt sources", "perplexity citations"] },
  ],
};

export const envelope = (task: Record<string, unknown>, status_code = 20000) => ({ status_code, cost: 0.0012, tasks: [task] });
