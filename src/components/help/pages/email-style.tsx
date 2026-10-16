import { H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";

export default function EmailStyleHelp() {
  return (
    <article>
      <H1>Email style</H1>
      <Lead>Give your emails your logo, colours and fonts. Set it once and every branded email wears it.</Lead>
      <Meta items={["About 5 minutes", "Admins", "Once per brand"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>
              A PNG or JPG logo in <Open href="/help/your-brand#logo">Brand › Logos</Open>
            </li>
            <li>
              Your colours in <Open href="/help/your-brand#colours">Brand › Colours</Open>
            </li>
          </>
        }
        unlocks={
          <>
            <li>Your look on welcome, invite, newsletter and journey emails</li>
            <li>The same look on sign-up confirmation and offboarding emails</li>
          </>
        }
      />

      <Warning>
        Add your logo and colours first. <strong>Use brand kit</strong> fills this page from them, so it can only use what&apos;s
        there.
      </Warning>

      <H2 id="start">Start from your brand kit</H2>
      <Steps>
        <li>
          Open <Open href="/admin/brand-kit/email-style">Brand › Email style</Open>.
        </li>
        <li>
          Press <strong>Use brand kit</strong>. It picks your primary logo and your brand colours.
        </li>
        <li>Read any notes it shows, then check the <strong>Preview</strong>.</li>
        <li>
          Press <strong>Save</strong>.
        </li>
      </Steps>
      <P>
        You can also ask Vizzy to suggest a style. It shows as a banner on this page: press <strong>Review</strong>, check the
        preview, then <strong>Save</strong>. Or press <strong>Dismiss</strong>.
      </P>

      <H2 id="header">Change the header and buttons</H2>
      <Steps>
        <li>
          Under <strong>Header</strong>, choose <strong>Colour</strong> (your logo and name on a colour) or{" "}
          <strong>Image</strong> (a full-width banner of your own).
        </li>
        <li>
          For Colour, pick a <strong>Logo</strong> or <strong>No logo</strong>. Add a <strong>Company name</strong> only if your
          logo doesn&apos;t show it.
        </li>
        <li>
          Pick a <strong>Header colour</strong>. Tick <strong>Gradient</strong> to fade it into <strong>Colour 2</strong>.
        </li>
        <li>
          For Image, press <strong>Upload a banner</strong> and pick a PNG or JPG, up to 1 MB.
        </li>
        <li>
          Pick a <strong>Button colour</strong>. Links use it too when it&apos;s dark enough to read.
        </li>
        <li>
          Press <strong>Save</strong>.
        </li>
      </Steps>
      <P>Outlook and Gmail on Android show the header colour alone, with no gradient, so make sure it works by itself.</P>

      <H2 id="theme">Pick a theme and fonts</H2>
      <Steps>
        <li>
          Under <strong>Theme</strong>, pick a look: <strong>Classic</strong>, <strong>Modern</strong>,{" "}
          <strong>Editorial</strong> or <strong>Friendly</strong>.
        </li>
        <li>
          Press <strong>Use brand fonts</strong> to take your Heading and Body fonts from Brand › Fonts. Or choose a{" "}
          <strong>Heading font</strong> and <strong>Body font</strong> yourself.
        </li>
        <li>
          Switch the preview between <strong>As Apple Mail sees it</strong> and{" "}
          <strong>As Gmail &amp; Outlook.com see it</strong>. Those two inboxes show standard fonts instead.
        </li>
        <li>
          Press <strong>Save</strong>.
        </li>
      </Steps>

      <H2 id="journey">Give one journey its own colours</H2>
      <P>A journey can have its own header and button colours. Its logo, name and theme stay your brand&apos;s.</P>
      <Steps>
        <li>
          Open the journey from <Open href="/admin/lifecycle">Journeys</Open> and go to its <strong>Settings</strong> tab.
        </li>
        <li>
          Under <strong>Email style</strong>, choose <strong>Custom for this journey</strong>.
        </li>
        <li>
          Pick its <strong>Header colour</strong> and <strong>Button colour</strong>.
        </li>
        <li>
          Press <strong>Publish</strong>. Every email the journey sends from then on uses the new colours.
        </li>
      </Steps>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>After you save, the page says &quot;Saved. Branded emails use this style from now on.&quot;</li>
        <li>The preview shows your header and button colours.</li>
        <li>
          On <Open href="/admin">Home</Open>, &quot;Style your emails&quot; is ticked.
        </li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          ["Only admins can change the Email style.", "Ask an admin on your team to make the change."],
          [
            "No logos yet",
            <>
              Add a PNG or JPG logo in <Open href="/admin/brand-kit/logos">Brand › Logos</Open>, then press{" "}
              <strong>Use brand kit</strong> again.
            </>,
          ],
          [
            "Your primary logo is WebP, which Outlook can't show",
            "Upload a PNG or JPG copy of your logo in Brand › Logos and set it as primary. Then press Use brand kit again.",
          ],
          [
            "No brand fonts yet",
            <>
              In <Open href="/admin/brand-kit/fonts">Brand › Fonts</Open>, choose a font for Heading and Body. Then press{" "}
              <strong>Use brand fonts</strong> again.
            </>,
          ],
          ["isn't available for email yet", "Emails can't use that font. Pick the closest one from the Heading font or Body font list."],
          ["The image is over 1 MB", "Save the banner smaller, or as a JPG, and upload it again."],
        ]}
      />

      <NextPage slug="email-style" />
    </article>
  );
}
