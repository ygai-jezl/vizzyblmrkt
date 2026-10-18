import { LangPage, langMetadata, type LangRouteProps } from "@/components/site/langRoute";

export const dynamic = "force-dynamic";

export const generateMetadata = (props: LangRouteProps) => langMetadata("ja", props);

/** The site under /ja (home, /ja/loop/<stage>, /ja/features/<feature>). 404 unless SITE_LANGUAGES_ENABLED. */
export default function Page(props: LangRouteProps) {
  return <LangPage lang="ja" params={props.params} />;
}
