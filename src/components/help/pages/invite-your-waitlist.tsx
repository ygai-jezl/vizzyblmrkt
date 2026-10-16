import { C, H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";

export default function InviteYourWaitlistHelp() {
  return (
    <article>
      <H1>Invite your waitlist</H1>
      <Lead>Bring people from the top of your waitlist into your product, one wave at a time.</Lead>
      <Meta items={["About 10 minutes", "Admins", "Each time you have room for more people"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>A launch with verified signups</li>
            <li>
              Your production app connected. See <Open href="/help/connect-your-product">Connect your product</Open>.
            </li>
            <li>The address of your app&apos;s sign-up page</li>
          </>
        }
        unlocks={
          <>
            <li>Invite emails with a personal link into your product</li>
            <li>Who signed up and who finished onboarding, for every wave</li>
          </>
        }
      />

      <Warning>
        Sending can&apos;t be undone. Each person leaves the waitlist as their invite goes out. Start with a small wave, and
        send a test to yourself first.
      </Warning>

      <H2 id="unlock">Unlock invites</H2>
      <P>
        At the top of your launch, <strong>Invite waitlist to product</strong> stays locked until your product is ready. The
        reason shows under the button. These steps clear the usual ones.
      </P>
      <Steps>
        <li>
          Open <Open href="/admin/products">Products</Open> and open your app. A sandbox doesn&apos;t count.
        </li>
        <li>
          Go to its <strong>Settings</strong> tab. Check <strong>Environment</strong> isn&apos;t <strong>Staging</strong>.
          Invites only go to production.
        </li>
        <li>
          In <strong>Allowed link domains</strong>, add your app&apos;s domain, such as app.yourproduct.com.
        </li>
        <li>
          In <strong>Sign-up link</strong>, paste the page where new people sign up. It must start with https:// and be on
          an allowed link domain.
        </li>
        <li>
          Press <strong>Save settings</strong>.
        </li>
      </Steps>
      <P>
        Used <strong>Learn from repo</strong>? Its <strong>Your app&apos;s web address</strong> field adds the domain for
        you. You still add the sign-up link yourself.
      </P>

      <H2 id="wave">Send a wave</H2>
      <Steps>
        <li>
          Open your launch and press <strong>Invite waitlist to product</strong>.
        </li>
        <li>
          Press <strong>New invite wave</strong>.
        </li>
        <li>
          Choose the <strong>Product</strong>. The line under it shows where people land.
        </li>
        <li>
          Set <strong>How many people</strong>. They come from the top of the waitlist, best rank first.
        </li>
        <li>
          Leave <strong>Skip people who already use the product</strong> ticked.
        </li>
        <li>
          Check <strong>Invite links work for (days)</strong>, the <strong>Subject</strong> and the <strong>Email</strong>.
          Keep <C>{"{{invite_link}}"}</C> in the email: it becomes the button.
        </li>
        <li>
          Press <strong>Preview</strong> to see how many people it would invite. Press <strong>Send a test to me</strong> to
          check the email.
        </li>
        <li>
          Press <strong>Send invites</strong>, then confirm.
        </li>
      </Steps>
      <P>
        Only verified people are invited. A wave skips anyone already invited from this launch and anyone without an email
        address. Vizzy can draft a wave for you: it shows as <strong>Drafted by Vizzy</strong> and waits for you to send it.
      </P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>The wave shows how many people were invited, signed up and activated.</li>
        <li>
          The funnel at the top counts <strong>Invited</strong>, <strong>Signed up</strong> and <strong>Activated</strong>.
          The last two come from your product&apos;s events, so your product must send them.
        </li>
        <li>
          Invited people move to <strong>Offboarded</strong> on the launch&apos;s <strong>Signups</strong> tab.
        </li>
        <li>On the Overview, the checklist ticks &quot;Invite your waitlist when the product is ready&quot;.</li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [
            "Connect your product first.",
            <>
              Connect your app on <Open href="/admin/products">Products</Open>. See{" "}
              <Open href="/help/connect-your-product">Connect your product</Open>.
            </>,
          ],
          [
            "Connect your production app",
            "Your only connection is staging. Connect your live app, or set its Environment to Production on its Settings tab.",
          ],
          ["Add your app's sign-up link in Products › Settings.", "Follow the Unlock invites steps above."],
          [
            "Invite links aren't set up yet.",
            "Whoever runs your YouGrow needs to set an invite link signing key (INVITE_LINK_SIGNING_KEY). If you run it yourself, see the setup guide in the repository.",
          ],
          ["This launch is archived.", "On the launch's Settings tab, press Restore launch."],
          [
            "Nobody left to invite: everyone verified has been invited or already uses the product.",
            "Wait for more people to join and verify, or untick Skip people who already use the product.",
          ],
        ]}
      />

      <NextPage slug="invite-your-waitlist" />
    </article>
  );
}
