/**
 * robots.txt for the public site. Everyone is welcome on the canonical host: search
 * engines, AI assistants, AI agents and AI training crawlers. Content-Signal states
 * that consent in machine-readable form (https://contentsignals.org). Every other host
 * (staging, the raw *.hosted.app address, localhost) is kept out of search, so only
 * yougrow.ai gets indexed.
 *
 * A crawler that finds its own name follows that group and ignores the "*" group, so
 * the named group repeats the rules in full. The AI names come from the community-kept
 * list at https://github.com/ai-robots-txt/ai.robots.txt.
 */

export const SEARCH_BOTS = [
  "Googlebot", "Bingbot", "DuckDuckBot", "Slurp", "YandexBot", "Baiduspider",
];

export const AI_BOTS = [
  "AddSearchBot", "AgentDataBot", "AgentTimes", "AI2Bot", "AI2Bot-DeepResearchEval",
  "Ai2Bot-Dolma", "aiHitBot", "AIWebIndex", "amazon-kendra", "amazon-QBusiness", "Amazonbot",
  "AmazonBuyForMe", "Amzn-SearchBot", "Amzn-User", "Andibot", "Anomura", "anthropic-ai",
  "ApifyBot", "ApifyWebsiteContentCrawler", "Applebot", "Applebot-Extended", "Aranet-SearchBot",
  "atlassian-bot", "Awario", "AzureAI-SearchBot", "bedrockbot", "bigsur.ai", "BixelBot",
  "Bravebot", "Brightbot", "BuddyBot", "Bytespider", "CCBot", "Channel3Bot", "ChatGLM-Spider",
  "ChatGPT Agent", "ChatGPT-User", "Claude-Code", "Claude-SearchBot", "Claude-User", "Claude-Web",
  "ClaudeBot", "Cloudflare-AutoRAG", "CloudflareBrowserRenderingCrawler", "CloudVertexBot",
  "cohere-ai", "cohere-training-data-crawler", "Cotoyogi", "CragCrawler", "Crawl4AI", "Crawlspace",
  "Cursor", "DeepSeekBot", "Devin", "Diffbot", "Diffbot-User", "DoubaoBot", "DuckAssistBot",
  "EchoboxBot", "ERNIEBot", "ExaBot", "ExaSearchBot", "FacebookBot", "facebookexternalhit",
  "FirecrawlAgent", "FriendlyCrawler", "Gemini-Deep-Research", "Google-Agent",
  "Google-CloudVertexBot", "Google-Extended", "Google-Firebase", "Google-Gemini-CLI",
  "Google-NotebookLM", "GoogleAgent-Mariner", "GoogleAgent-URLContext", "GoogleOther",
  "GoogleOther-Image", "GoogleOther-Video", "GPTBot", "iAskBot", "iaskspider", "ICC-Crawler",
  "ImagesiftBot", "img2dataset", "kagi-fetcher", "Kangaroo Bot", "KeenableBot", "Kimi-Agent",
  "Kimi-SearchBot", "Kimi-User", "KimiBot", "KlaviyoAIBot", "laion-huggingface-processor",
  "LAIONDownloader", "LinerBot", "LinkupBot", "Manus-User", "Meta-ExternalAgent",
  "Meta-ExternalFetcher", "meta-webindexer", "MistralAI-Index", "MistralAI-Training",
  "MistralAI-User", "Mozilla-Tabstack", "NotebookLM", "NovaAct", "OAI-AdsBot", "OAI-SearchBot",
  "omgili", "omgilibot", "OpenAI", "opencode", "Operator", "PanguBot", "Panscient",
  "Perplexity-User", "PerplexityBot", "PetalBot", "PhindBot", "Poggio-Citations", "QualifiedBot",
  "Querit-SearchBot", "QueritBot", "QuillBot", "QwenBot", "Reflectionbot", "SBIntuitionsBot",
  "SemrushBot-OCOB", "SemrushBot-SWA", "ShapBot", "Shap-User", "TavilyBot", "TerraCotta",
  "Thinkbot", "TikTokSpider", "Timpibot", "TongyiBot", "Trae", "TwinAgent",
  "VelenPublicWebCrawler", "WARDBot", "Webzio-Extended", "wpbot", "WRTNBot", "YandexAdditional",
  "YandexAdditionalBot", "YiyanBot", "YouBot", "ZanistaBot",
];

/** The signed-in app, its API and one-off personal links: nothing a crawler could use. */
export const DISALLOW = ["/admin", "/admin-preview", "/api/", "/embed/", "/invite/", "/login", "/unsubscribe"];

export const CONTENT_SIGNAL = "search=yes, ai-input=yes, ai-train=yes";

export function robotsTxt(origin: string, opts: { indexable: boolean }): string {
  if (!opts.indexable) {
    return [
      "# This is not the public address of the site. Search engines index " + origin + " instead.",
      "User-agent: *",
      "Disallow: /",
      "",
    ].join("\n");
  }
  const rules = [`Content-Signal: ${CONTENT_SIGNAL}`, "Allow: /", ...DISALLOW.map((p) => `Disallow: ${p}`)];
  return [
    `# robots.txt for ${origin}`,
    "#",
    "# Everyone is welcome here: search engines, AI assistants, AI agents and",
    "# AI training crawlers. Read, quote, cite and learn from every public page.",
    "#",
    "# Content-Signal states that consent in machine-readable form:",
    "#   search   = show our pages in search results",
    "#   ai-input = use our pages to answer questions (AI search, assistants, agents)",
    "#   ai-train = use our pages to train or fine-tune AI models",
    "#",
    "# The only paths kept out are the signed-in app, its API and one-off personal",
    "# links (invites, unsubscribe). They hold nothing a crawler could use.",
    "",
    "User-agent: *",
    ...rules,
    "",
    "# The same welcome, by name. A crawler that finds its own name follows that",
    "# group and ignores the \"*\" group above, so the rules are repeated in full.",
    "# Search engines:",
    ...SEARCH_BOTS.map((b) => `User-agent: ${b}`),
    "# AI search, assistants, agents and training crawlers:",
    ...AI_BOTS.map((b) => `User-agent: ${b}`),
    ...rules,
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
    `# For AI agents: a plain-language guide to this site is at ${origin}/llms.txt`,
    "",
  ].join("\n");
}
