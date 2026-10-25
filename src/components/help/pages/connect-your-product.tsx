import { C, H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning, WhoGetsWhichEmails } from "@/components/help/blocks";
import { isSiteSignupsEnabled } from "@/lib/waitlist/siteFlags";

export default function ConnectYourProductHelp() {
  return (
    <article>
      <H1>Connect your product</H1>
      <Lead>Tell YouGrow about your app and the steps of getting started in it, then hand the coding to your developer.</Lead>
      <Meta items={["About 15 minutes, plus your developer's time", "Admins", "Once per product"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>Your app&apos;s code on GitHub or GitLab</li>
            <li>A developer who can change your app&apos;s server</li>
          </>
        }
        unlocks={
          <>
            <li>Onboarding journeys for your product&apos;s users</li>
            <li>A page for each user in Audience</li>
            <li>Inviting your waitlist into your product</li>
          </>
        }
      />

      <Warning>
        Learn your steps, with your app&apos;s web address, before you build a journey. Without steps, the 7-day journey
        can&apos;t be published. Without the address, the buttons in its emails have no link.
      </Warning>

      <H2 id="sandbox">Try a sandbox first</H2>
      <P>
        A sandbox is a pretend product with a demo catalog and one test user: you. Try a journey on it before anyone writes
        code. It doesn&apos;t count as your product, on Home or for invites.
      </P>
      <Steps>
        <li>
          Open <Open href="/admin/products">Products</Open> and press <strong>Create sandbox</strong>.
        </li>
        <li>
          Press <strong>Create</strong>, then <strong>Open the sandbox</strong>.
        </li>
        <li>
          On the <strong>Sandbox</strong> tab, your test user has your sign-in email. To change it, edit it and press{" "}
          <strong>Save test users</strong>. It must be yours or on your verified domain.
        </li>
        <li>
          <Open href="/help/onboarding-journeys#build">Build a journey</Open> on the sandbox and publish it.
        </li>
        <li>
          Back on the <strong>Sandbox</strong> tab, press <strong>Signed up</strong>, then a step, to act as your product.
        </li>
      </Steps>

      <H2 id="connect">Connect a product</H2>
      <Steps>
        <li>
          On <Open href="/admin/products">Products</Open>, press <strong>Connect a product</strong>.
        </li>
        <li>
          Type a <strong>Name</strong>, such as your app&apos;s name.
        </li>
        <li>
          Under <strong>Which copy of your product is this?</strong>, choose <strong>Staging</strong>,{" "}
          <strong>Production</strong> or <strong>Not sure yet</strong>. Have both? Connect staging first, to test safely.
        </li>
        <li>
          Press <strong>Create</strong>.
        </li>
        <li>
          Copy the key id and the secret into your password manager, to share with your developer. The secret is shown only
          once.
        </li>
        <li>
          Tick <strong>I&apos;ve stored the secret somewhere safe</strong>, press <strong>Next</strong>, then{" "}
          <strong>Learn from my repo</strong>.
        </li>
      </Steps>

      <H2 id="learn">Learn your steps from your repo</H2>
      <P>
        YouGrow reads your code and suggests your onboarding steps, events and facts. It never changes your code.
      </P>
      <Steps>
        <li>
          On the product&apos;s <strong>Learn from repo</strong> tab, press <strong>Connect GitHub</strong> and choose the
          repositories it may read. On GitLab, or a public repo? Press{" "}
          <strong>Add a repository by address (GitLab or public)</strong> instead.
        </li>
        <li>
          Tick up to 3, such as your web app and your backend, and press <strong>Learn from repo</strong>. It takes a few
          minutes, and you can leave the page.
        </li>
        <li>
          Read what it found. The trusted items are already ticked. Untick anything that&apos;s wrong.
        </li>
        <li>
          Under <strong>Add to the catalog</strong>, type <strong>Your app&apos;s web address</strong>, such as
          https://app.yourproduct.com. This turns each step into a link in your emails.
        </li>
        <li>
          Press <strong>Add selected to the catalog</strong>. The <strong>Catalog</strong> tab opens with what you kept.
        </li>
      </Steps>
      <P>
        No steps found? Run it again on the repository that holds your sign-up and setup, or add the steps yourself on the{" "}
        <strong>Catalog</strong> tab. In a company&apos;s GitHub organisation, an owner may need to approve the app first. See{" "}
        <Open href="/developers/connect-your-code">how connecting works</Open>.
      </P>

      <H2 id="developer">What to send your developer</H2>
      <Steps>
        <li>The key id and secret, through your password manager.</li>
        <li>
          The prompt from <strong>Copy prompt</strong> on the <strong>Integration guide</strong> tab. A coding agent such as
          Claude Code or Cursor can work from it. It has no secrets in it.
        </li>
        <li>
          The <Open href="/developers">developer docs</Open>.
        </li>
      </Steps>
      <P>
        Sign-ups come first: without them, no journey sends anything. Each sign-up should include consent, or only the
        welcome email goes out. Steps come next. The guide lists every task in that order, and says what happens if it&apos;s
        skipped. Details: <Open href="/developers/users">sending users</Open>. The <strong>Setup</strong> tab ticks each part
        off as it arrives.
      </P>

      {isSiteSignupsEnabled() ? (
        <>
          <H2 id="newsletter">Your app&apos;s users and your newsletter</H2>
          <P>
            People your app sends get onboarding journeys only, never broadcasts or the weekly newsletter. Want a newsletter
            list? Use a launch&apos;s site key, not <C>users.update</C>. See{" "}
            <Open href="/help/newsletter-from-your-site">Newsletter from your own site</Open>.
          </P>
          <WhoGetsWhichEmails />
        </>
      ) : null}

      <H2 id="test">Test the context endpoint (optional)</H2>
      <P>
        Only for emails that tell people what their own results mean. Your developer builds the{" "}
        <Open href="/developers/context-endpoint">context endpoint</Open> and adds its address on the{" "}
        <strong>Settings</strong> tab, with <strong>Enabled</strong> ticked.
      </P>
      <Steps>
        <li>
          On the <strong>Test connection</strong> tab, type one user&apos;s id, as your app knows them.
        </li>
        <li>
          Press <strong>Test connection</strong>. A good answer starts &quot;Valid context in&quot; and lists their steps,
          facts and insight sentences.
        </li>
      </Steps>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>
          The <strong>Setup</strong> tab ticks <strong>Learn your product from its repo</strong> and{" "}
          <strong>Receive your users&apos; sign-ups and steps</strong>.
        </li>
        <li>
          The <strong>Events</strong> tab lists what your app sends. Refused writes show under{" "}
          <strong>Recent rejections</strong>, with the reason.
        </li>
        <li>
          On <Open href="/admin">Home</Open>, Launch product says &quot;Receiving events&quot;.
        </li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [
            "That isn't a GitHub or GitLab repository address (e.g. github.com/your-org/your-app).",
            "Paste the repository's address, such as github.com/your-org/your-app.",
          ],
          ["Your app's address must start with https://.", "Type the full address, starting https://."],
          [
            "Repo analysis isn't set up in this environment yet.",
            "Whoever runs your YouGrow needs to set it up. Until then, add your steps on the Catalog tab.",
          ],
          [
            "No context endpoint is set up (or it's disabled)",
            "Add its address on the Settings tab, tick Enabled and press Save settings.",
          ],
        ]}
      />

      <NextPage slug="connect-your-product" />
    </article>
  );
}
