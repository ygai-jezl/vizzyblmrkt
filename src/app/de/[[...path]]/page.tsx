import { LangPage, langMetadata, type LangRouteProps } from "@/components/site/langRoute";

export const dynamic = "force-dynamic";

export const generateMetadata = (props: LangRouteProps) => langMetadata("de", props);

/** The site under /de (home, /de/loop/<stage>, /de/features/<feature>). 404 unless SITE_LANGUAGES_ENABLED. */
export default function Page(props: LangRouteProps) {
  return <LangPage lang="de" params={props.params} />;
}
