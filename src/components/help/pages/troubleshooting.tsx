import { H1, H2, Lead, P, UL } from "@/components/developers/Doc";
import { NextPage, Open } from "@/components/help/blocks";

export default function TroubleshootingHelp() {
  return (
    <article>
      <H1>Why isn&apos;t this working?</H1>
      <Lead>Find what you&apos;re seeing. Each one says why it happens and how to fix it.</Lead>

      <H2 id="default-address">My emails come from an address that isn&apos;t mine</H2>
      <P>
        Your sending domain isn&apos;t verified yet, or your From address isn&apos;t on it. Until then, emails go out from a
        shared default address. <Open href="/help/email-sending">Set up email sending</Open>.
      </P>

      <H2 id="welcome-everyone">My welcome email went to everyone on my waitlist</H2>
      <P>
        The first time you turn on a launch&apos;s welcome email, it goes to everyone already signed up. It can&apos;t be called
        back. Next time, turn it on before you share your page.{" "}
        <Open href="/help/launch-and-waitlist#welcome">Turn on the welcome email</Open>.
      </P>

      <H2 id="brand-map">Blog articles ignore my brand map</H2>
      <P>
        Your brand map isn&apos;t saved. Until it is, articles are written without it. Press <strong>Save brand map</strong> in{" "}
        <Open href="/admin/brand-kit/map">Brand › Brand map</Open>. Articles already written stay as they are.
      </P>

      <H2 id="post-failed">My post failed</H2>
      <P>
        LinkedIn or X wasn&apos;t connected when it was due. <Open href="/admin/approvals">Review</Open> shows &quot;Connect
        LinkedIn to publish this post&quot; or the same for X. Connect it in{" "}
        <Open href="/admin/account/connections">Settings › Integrations</Open>, then press <strong>Reschedule</strong> on the
        post in your programme&apos;s <strong>Calendar</strong> tab.
      </P>

      <H2 id="sandbox">My sandbox doesn&apos;t count as my product</H2>
      <P>
        That&apos;s on purpose: a sandbox is only for trying things. Home leaves &quot;Connect your product&quot; unticked, and
        invites can&apos;t go to it. <Open href="/help/connect-your-product#connect">Connect your real app</Open>.
      </P>

      <H2 id="no-steps">Learn from repo found no onboarding steps</H2>
      <P>
        It read a repository without your sign-up and setup flow. Run it again on the one that has it, or add the steps yourself
        on the product&apos;s <strong>Catalog</strong> tab. <Open href="/help/connect-your-product#learn">Learn from repo</Open>.
      </P>

      <H2 id="lost-secret">I lost my product&apos;s secret</H2>
      <P>
        It&apos;s shown only once. Press <strong>Rotate secret</strong> on the product&apos;s <strong>Settings</strong> tab in{" "}
        <Open href="/admin/products">Products</Open>. The old one keeps working for 24 hours, while your developer swaps it.
      </P>

      <H2 id="no-users">No users arrive from my app</H2>
      <P>
        Open the product&apos;s <strong>Events</strong> tab. Empty means your developer hasn&apos;t sent anything yet. Anything
        refused is under <strong>Recent rejections</strong>, with the reason. Each user must be sent before their events:{" "}
        <Open href="/developers/users">sending users</Open>.
      </P>

      <H2 id="invites-locked">I can&apos;t invite my waitlist</H2>
      <P>The locked button says why:</P>
      <UL>
        <li>
          &quot;Connect your product first.&quot; Connect your real app. A sandbox doesn&apos;t count.
        </li>
        <li>&quot;Connect your production app&quot;. Invites go to production, not staging.</li>
        <li>
          &quot;Add your app&apos;s sign-up link in Products › Settings.&quot; Add it as <strong>Sign-up link</strong> on the
          product&apos;s <strong>Settings</strong> tab.
        </li>
        <li>&quot;Invite links aren&apos;t set up yet.&quot; Whoever runs your YouGrow needs to set them up.</li>
      </UL>
      <P>
        <Open href="/help/invite-your-waitlist">Invite your waitlist</Open>.
      </P>

      <H2 id="wont-publish">My journey won&apos;t publish</H2>
      <P>The list of things to fix, above the tabs, says why. The usual ones:</P>
      <UL>
        <li>
          &quot;An email shows the onboarding checklist or next step, but this product has no onboarding steps yet.&quot; Add
          steps with <Open href="/help/connect-your-product#learn">Learn from repo</Open>, then make a new journey from the
          template.
        </li>
        <li>&quot;Add at least one email.&quot; Add an email on the Canvas tab.</li>
        <li>
          &quot;Add at least one branch.&quot; or &quot;Connect every branch to a next step.&quot; Finish each split on the
          Canvas tab.
        </li>
      </UL>

      <H2 id="nobody-joins">Nobody joins my journey</H2>
      <UL>
        <li>
          <strong>Not published, or paused.</strong> Press <strong>Publish</strong>, or <strong>Resume</strong>.
        </li>
        <li>
          <strong>Test mode.</strong> Only listed test users join. Add them on the <strong>Delivery</strong> tab, or switch to
          shadow or live.
        </li>
        <li>
          <strong>Signed up too long ago.</strong> It only takes people who signed up in the last 72 hours. Raise{" "}
          <strong>Ignore events older than (hours)</strong> on its <strong>Settings</strong> tab, up to 720.
        </li>
        <li>
          <strong>Already been through it.</strong> Each person joins a sign-up journey once.
        </li>
        <li>
          <strong>No sign-up sent.</strong> If the product&apos;s <strong>Events</strong> tab doesn&apos;t show them, your app
          hasn&apos;t sent their sign-up.
        </li>
      </UL>
      <P>
        <Open href="/help/onboarding-journeys#test">Publish it in test mode</Open>.
      </P>

      <H2 id="only-welcome">Only the welcome email arrives</H2>
      <P>
        The welcome is a service email. The rest are marketing, and they need the consent your app sends at sign-up. Without
        it, they don&apos;t go out, and the person&apos;s page says &quot;Service emails only&quot;. Ask your developer to send consent:{" "}
        <Open href="/developers/users">sending users</Open>.
      </P>

      <H2 id="no-link">The buttons in my emails don&apos;t go anywhere</H2>
      <P>
        Your steps have no links, or the links aren&apos;t on your app&apos;s domain. Run{" "}
        <Open href="/help/connect-your-product#learn">Learn from repo</Open> again, fill in{" "}
        <strong>Your app&apos;s web address</strong> and tick the steps again. Or give each step a full link on the{" "}
        <strong>Catalog</strong> tab, with its domain in <strong>Allowed link domains</strong> on the <strong>Settings</strong>{" "}
        tab.
      </P>

      <H2 id="cant-go-live">I can&apos;t switch a journey to live</H2>
      <P>
        Live needs a From address on a verified sending domain, and marketing emails also need your postal address. Add both
        in <Open href="/admin/account">Settings › Sending</Open>. If the <strong>Delivery</strong> tab says this environment only
        allows test or shadow, whoever runs your YouGrow must raise it.
      </P>

      <H2 id="ai-line">An AI line didn&apos;t go out</H2>
      <P>
        Usually nobody approved it in time, so the email went out in its standard wording. Approve lines in{" "}
        <Open href="/admin/approvals">Review</Open> well before they&apos;re due. Ones too close to their send time can&apos;t
        be approved.
      </P>

      <NextPage slug="troubleshooting" />
    </article>
  );
}
