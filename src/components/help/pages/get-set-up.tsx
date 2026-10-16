import { H1, H2, H3, Lead, P, UL } from "@/components/developers/Doc";
import { NextPage, Open, Warning } from "@/components/help/blocks";

/** The /help hub: the five setup stages in order, and where the order matters. */
export default function GetSetUpHelp() {
  return (
    <article>
      <H1>Get set up</H1>
      <Lead>Five stages, in order. Each one unlocks the next. Home shows where you are and what to do next.</Lead>

      <H2 id="brand">First, your brand</H2>
      <P>
        Everything in YouGrow belongs to a brand. Make one from the brand switcher at the top of the sidebar with{" "}
        <strong>Add Brand</strong>, or <Open href="/admin/brands/new">here</Open>. You need its name, your website (such as
        yourbrand.com) and a <strong>Data region</strong>. The region is where its data lives, and it can&apos;t be changed
        later.
      </P>

      <H2 id="ready">1. Get ready</H2>
      <P>About 30 minutes plus DNS time, once per brand. Do this before anything goes out.</P>
      <UL>
        <li>
          <Open href="/help/email-sending#domain">Verify your sending domain</Open>
        </li>
        <li>
          <Open href="/help/email-sending#sender">Add your sender details</Open>: From address, privacy policy link and postal
          address
        </li>
        <li>
          <Open href="/help/your-brand#logo">Add your logo</Open> and{" "}
          <Open href="/help/your-brand#voice">set your brand voice</Open>
        </li>
        <li>
          <Open href="/help/email-style">Style your emails</Open>
        </li>
      </UL>

      <H2 id="launch">2. Launch</H2>
      <P>Start a waitlist for what you&apos;re building.</P>
      <UL>
        <li>
          <Open href="/help/launch-and-waitlist#create">Create a launch</Open>
        </li>
        <li>
          <Open href="/help/launch-and-waitlist#welcome">Turn on the welcome email</Open>
        </li>
        <li>
          <Open href="/help/launch-and-waitlist#share">Share your waitlist page</Open>
        </li>
      </UL>

      <H2 id="grow">3. Grow audience</H2>
      <P>Write content that brings people to your waitlist.</P>
      <UL>
        <li>
          <Open href="/help/programmes-and-knowledge#start">Start a content programme</Open> and{" "}
          <Open href="/help/programmes-and-knowledge#knowledge">add your website to its knowledge</Open>
        </li>
        <li>
          <Open href="/help/brand-map">Save your brand map</Open>, if you&apos;ll write blog articles
        </li>
        <li>
          <Open href="/help/connected-accounts#social">Connect LinkedIn or X</Open>, then{" "}
          <Open href="/help/write-and-schedule#schedule">schedule your first post</Open>
        </li>
        <li>
          <Open href="/help/write-and-schedule#newsletter">Send a newsletter to your waitlist</Open>
        </li>
      </UL>

      <H2 id="product">4. Launch product</H2>
      <P>Connect your app so YouGrow knows what each person does in it. Part of this is for your developer.</P>
      <UL>
        <li>
          <Open href="/help/connect-your-product#sandbox">Try a sandbox</Open> to see the whole flow first (optional)
        </li>
        <li>
          <Open href="/help/connect-your-product#connect">Connect your product</Open> and{" "}
          <Open href="/help/connect-your-product#learn">learn it from your repo</Open>
        </li>
        <li>
          <Open href="/help/connect-your-product#developer">Hand the rest to your developer</Open>, and wait for your first
          sign-up
        </li>
        <li>
          <Open href="/help/invite-your-waitlist">Invite your waitlist</Open>
        </li>
      </UL>

      <H2 id="retain">5. Onboard &amp; retain</H2>
      <P>Email each person about what they have and haven&apos;t done yet.</P>
      <UL>
        <li>
          <Open href="/help/onboarding-journeys#build">Build an onboarding journey</Open>
        </li>
        <li>
          <Open href="/help/onboarding-journeys#test">Test it on real people</Open>
        </li>
        <li>
          <Open href="/help/onboarding-journeys#live">Switch it to live</Open>
        </li>
      </UL>

      <H2 id="order">Where the order matters</H2>
      <Warning>
        <strong>Domain first.</strong> Until it&apos;s verified, your emails come from a shared default address and no journey
        can go live.
      </Warning>
      <Warning>
        <strong>Welcome email before you share your page.</strong> The first time you turn it on, it goes to everyone already
        signed up.
      </Warning>
      <Warning>
        <strong>Journey before sign-ups flow.</strong> A journey only takes people who signed up in the last 3 days, unless you
        widen that in its Settings.
      </Warning>
      <Warning>
        <strong>Accounts before posts.</strong> A post scheduled without LinkedIn or X connected fails when it&apos;s due.
      </Warning>

      <H2 id="help">Getting help</H2>
      <H3>Ask Vizzy</H3>
      <P>
        Vizzy is the assistant inside YouGrow. Ask it &quot;What should I set up first?&quot; and it reads where you are. It
        drafts things for you, and nothing goes live until you publish it.
      </P>
      <H3>Something not working?</H3>
      <P>
        Start with <Open href="/help/troubleshooting">Why isn&apos;t this working?</Open>
      </P>
      <H3>For developers</H3>
      <P>
        Connecting your app is in the <Open href="/developers">developer docs</Open>. They also work as instructions for a
        coding agent.
      </P>

      <NextPage slug="" />
    </article>
  );
}
