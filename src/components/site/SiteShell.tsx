import type { ReactNode } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import "./site.css";
import { FEATURES, FEATURE_TAGS, STAGES, STAGE_IDS, type StageId } from "@/lib/site/content";
import { isDevelopersDocsEnabled } from "@/lib/developers/flags";
import { isHelpPagesEnabled } from "@/lib/help/flags";
import { isSiteLanguagesEnabled, isSiteSeoEnabled, siteOrigin } from "@/lib/site/flags";
import { GITHUB_URL, LINKEDIN_URL } from "@/lib/site/home";
import { translator, type Translator } from "@/lib/site/i18n";
import { SITE_THEME_COOKIE } from "@/lib/site/theme";
import { parseThemePreference } from "@/lib/theme";
import { serializeJsonLd, siteGraph } from "@/lib/site/jsonLd";
import { LANG_INFO, SITE_LANGS, sitePath, type SiteLang, type SitePage } from "@/lib/site/langs";
import { SITE_FONT_VARS } from "./fonts";
import { GITHUB_ICON, LINKEDIN_ICON, LoopMarkSymbol } from "./icons";
import { SiteBehaviour } from "./SiteBehaviour";
import { SiteHeader, type MenuStage } from "./SiteHeader";
import { ThemeSwitch } from "./ThemeSwitch";
import type { LoopLabels } from "./Loops";

/** The loop's words in a language, for the client loop components. */
export function loopLabels(t: Translator["t"]): LoopLabels {
  return {
    stages: Object.fromEntries(STAGE_IDS.map((id) => [id, t(STAGES[id].name)])),
    core: t("GROWTH|MEMORY").split("|"),
    ghost: [t("MAKE"), t("GROW")],
    approve: t("You approve"),
    back: t("Back to memory"),
  };
}

function menuStages(lang: SiteLang, ids: StageId[]): MenuStage[] {
  const { t } = translator(lang);
  return ids.map((id) => ({
    name: t(STAGES[id].name),
    href: sitePath(lang, { kind: "stage", id }),
    color: STAGES[id].color,
    features: STAGES[id].features.map((f) => ({ name: t(FEATURES[f].name), tag: t(FEATURE_TAGS[f]), href: sitePath(lang, { kind: "feature", slug: f }) })),
  }));
}

/**
 * Every page of the loop site: the .yg wrapper (language, direction, fonts), the nav
 * block, the footer and the page's JSON-LD. `around` is the previous and next page
 * for the arrow keys on a stage page.
 */
export async function SiteShell({ lang, page, children, around, withFaq }: {
  lang: SiteLang;
  page: SitePage;
  children: ReactNode;
  around?: { prev: string; next: string };
  withFaq?: boolean;
}) {
  const { t } = translator(lang);
  const info = LANG_INFO[lang];
  const home = sitePath(lang, { kind: "home" });
  const languages = isSiteLanguagesEnabled()
    ? SITE_LANGS.map((l) => ({ code: l, name: LANG_INFO[l].name, href: sitePath(l, page), current: l === lang }))
    : [];
  const seo = isSiteSeoEnabled();
  // Light, system or dark: an explicit choice is in a cookie, so the first paint is already right.
  const theme = parseThemePreference((await cookies()).get(SITE_THEME_COOKIE)?.value);
  return (
    <div className={`yg ${SITE_FONT_VARS}`} lang={lang} dir={info.dir} data-yg-theme={theme === "system" ? undefined : theme}>
      <LoopMarkSymbol />
      <SiteHeader
        homeHref={home}
        labels={{
          features: t("Features"), loop: t("The Loop"), developers: t("Developers"), login: t("Log in"), join: t("Join"),
          language: t("Language"), make: t("Make"), grow: t("Grow"), seeItWork: t("See it work"),
          featured: t(FEATURES.canvas.name), featuredBlurb: t("One idea becomes a whole campaign, in five steps. Watch it happen."), howItWorks: t("How it works"),
        }}
        make={menuStages(lang, ["understand", "plan", "create"])}
        grow={menuStages(lang, ["launch", "engage", "learn"])}
        featuredHref={sitePath(lang, { kind: "feature", slug: "canvas" })}
        languages={languages}
      />
      <div className="site-tools">
        <ThemeSwitch initial={theme} labels={{ theme: t("Theme"), light: t("Light"), system: t("System"), dark: t("Dark") }} />
      </div>
      {children}
      <footer>
        <div className="l">
          <span dir="ltr">© 2026 YouGrow.ai</span>
          {isDevelopersDocsEnabled() ? <Link href="/developers">{t("Developers")}</Link> : null}
          {isHelpPagesEnabled() ? <Link href="/help">{t("Help")}</Link> : null}
        </div>
        {seo ? (
          <span className="files">
            <a href="/sitemap.xml">sitemap.xml</a>
            <a href="/robots.txt">robots.txt</a>
            <a href="/llms.txt">llms.txt</a>
          </span>
        ) : null}
        <span className="social">
          <a href={GITHUB_URL} target="_blank" rel="noopener" aria-label="YouGrow on GitHub" title="GitHub">{GITHUB_ICON}</a>
          <a href={LINKEDIN_URL} target="_blank" rel="noopener" aria-label="YouGrow on LinkedIn" title="LinkedIn">{LINKEDIN_ICON}</a>
        </span>
      </footer>
      {seo ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(siteGraph(siteOrigin(), lang, page, { withFaq })) }} />
      ) : null}
      <SiteBehaviour lang={lang} dir={info.dir} prevHref={around?.prev} nextHref={around?.next} />
    </div>
  );
}
