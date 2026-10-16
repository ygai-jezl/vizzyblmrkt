import { H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";

export default function EmailSendingHelp() {
  return (
    <article>
      <H1>Set up email sending</H1>
      <Lead>Send every email from your own domain, with the footer details the law asks for.</Lead>
      <Meta items={["About 10 minutes, plus DNS time", "Admins", "Once per brand"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>Your brand in YouGrow</li>
            <li>Access to your domain&apos;s DNS settings</li>
          </>
        }
        unlocks={
          <>
            <li>Sign-up, waitlist and invite emails from your own address</li>
            <li>Journeys that send to real people</li>
          </>
        }
      />

      <Warning>
        Do this first. Until a domain is verified, your emails go out from the platform&apos;s shared default address, and no
        journey can go live.
      </Warning>

      <H2 id="domain">Verify your sending domain</H2>
      <Steps>
        <li>
          Open <Open href="/admin/account">Settings › Sending</Open>.
        </li>
        <li>
          Under <strong>Your domains</strong>, type the domain you&apos;ll send from and press <strong>Add domain</strong>. A
          subdomain such as mail.yourbrand.com keeps email separate from your website.
        </li>
        <li>Copy each DNS record it shows into your DNS provider. Each one has a copy button.</li>
        <li>
          Press <strong>Verify</strong>. If a record isn&apos;t valid yet, DNS hasn&apos;t updated: wait a while and press it
          again.
        </li>
      </Steps>

      <H2 id="sender">Add your sender details</H2>
      <P>
        These are under <strong>Default email sender</strong> on the same page. Every launch and journey uses them unless you
        change them there.
      </P>
      <Steps>
        <li>
          Enter a <strong>Sender name</strong>, such as your brand or your team.
        </li>
        <li>
          Choose your <strong>From address</strong>: the part before the @, and your verified domain.
        </li>
        <li>
          Add a <strong>Reply-to address</strong> if replies should go somewhere else.
        </li>
        <li>
          Add your <strong>Privacy Policy URL</strong>. Every email footer links to it.
        </li>
        <li>
          Add your <strong>Postal address</strong>. Marketing emails are held without one.
        </li>
        <li>
          Press <strong>Save sender</strong>.
        </li>
      </Steps>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>Your domain shows a tick against every DNS record.</li>
        <li>The From address picker lists your domain.</li>
        <li>
          On <Open href="/admin">Home</Open>, &quot;Verify your sending domain&quot; and &quot;Add your sender details&quot; are
          ticked.
        </li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          ["Verify a domain first", "The From address picker needs a verified domain. Finish the first set of steps."],
          ["That doesn't look like a valid domain (e.g. mail.yourbrand.com).", "Type the domain only, with no https:// and no slash."],
          ["Enter a valid Privacy Policy URL (https://…)", "Use the full address of your privacy policy, starting https://."],
          [
            "Live sending needs a From address on a verified sending domain.",
            "A journey tried to go live first. Finish this page, then switch the journey to live again.",
          ],
          [
            "Live verification needs an email provider (MANDRILL_API_KEY) configured.",
            "Whoever runs your YouGrow needs to add an email provider key. If you run it yourself, see the setup guide in the repository.",
          ],
        ]}
      />

      <NextPage slug="email-sending" />
    </article>
  );
}
