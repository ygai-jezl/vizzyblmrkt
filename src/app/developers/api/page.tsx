import Link from "next/link";
import { H1, Lead, P } from "@/components/developers/Doc";
import { SCALAR_SCRIPT } from "@/lib/developers/scalar";
import { ApiReference } from "./ApiReference";

const SPEC = "/developers/openapi.json";

/** The OpenAPI spec, rendered for people. It has no Markdown twin: agents read the spec itself. */
export default function ApiReferencePage() {
  return (
    <article>
      <H1>API reference</H1>
      <Lead>
        Every endpoint, field and response of API v2, from the same OpenAPI 3.1 spec your tools can load:{" "}
        <a className="underline" href={SPEC}>
          {SPEC}
        </a>
        .
      </Lead>
      <P>
        What YouGrow sends <em>you</em> — the optional context request and webhooks — is under <strong>Webhooks</strong>.
        For how the pieces fit together, with examples, start with{" "}
        <Link className="underline" href="/developers/users">
          sending users
        </Link>
        . Requests authenticate with HTTP Basic — your key id and secret — and come from your server only.
      </P>
      <noscript>
        <P>
          The reference needs JavaScript. The spec itself is at <a href={SPEC}>{SPEC}</a>.
        </P>
      </noscript>
      <ApiReference specUrl={SPEC} src={SCALAR_SCRIPT.src} integrity={SCALAR_SCRIPT.integrity} />
    </article>
  );
}
