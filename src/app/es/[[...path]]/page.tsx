import { LangPage, langMetadata, type LangRouteProps } from "@/components/site/langRoute";

export const dynamic = "force-dynamic";

export const generateMetadata = (props: LangRouteProps) => langMetadata("es", props);

/** The site under /es (home, /es/loop/<stage>, /es/features/<feature>). 404 unless SITE_LANGUAGES_ENABLED. */
export default function Page(props: LangRouteProps) {
  return <LangPage lang="es" params={props.params} />;
}
