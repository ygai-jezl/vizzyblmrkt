import { H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";

export default function YourBrandHelp() {
  return (
    <article>
      <H1>Your brand</H1>
      <Lead>Add your logo, colours and fonts, and write your brand voice, so everything Vizzy makes looks and sounds like you.</Lead>
      <Meta items={["About 15 minutes", "Anyone on your team", "Once per brand"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>Your logo as a PNG or JPG file</li>
            <li>
              Your website as the brand&apos;s <strong>Primary domain</strong> (you added it when you made the brand)
            </li>
            <li>Your brand guidelines PDF, if you have one</li>
          </>
        }
        unlocks={
          <>
            <li>Posts, articles and emails written in your voice</li>
            <li>
              Your logo and colours on your emails, through <Open href="/help/email-style">Email style</Open>
            </li>
          </>
        }
      />

      <Warning>
        Got a guidelines PDF? Add it before your colours. Reading a PDF replaces your Colour palette with the colours it
        finds.
      </Warning>

      <H2 id="logo">Add your logo</H2>
      <Steps>
        <li>
          Open <Open href="/admin/brand-kit/logos">Brand › Logos</Open>.
        </li>
        <li>
          Press <strong>Add logo</strong> and pick your file. It can be up to 8 MB.
        </li>
        <li>
          Your first logo becomes the <strong>Primary</strong>. To change it, press the three dots on another logo and choose{" "}
          <strong>Set as primary</strong>.
        </li>
      </Steps>
      <P>Use a PNG or JPG. A WebP logo uploads, but your emails can&apos;t use it, because Outlook can&apos;t show it.</P>

      <H2 id="guidelines">Add your guidelines PDF (optional)</H2>
      <Steps>
        <li>
          Open <Open href="/admin/brand-kit/guidelines">Brand › Guidelines</Open>.
        </li>
        <li>
          Press <strong>Upload brand guidelines (PDF)</strong>. It can be up to 14MB.
        </li>
        <li>Wait while it reads the file. It fills in the fields below, such as Colours, Fonts and Tone.</li>
        <li>
          Fix anything that&apos;s wrong, then press <strong>Save brand kit</strong>.
        </li>
      </Steps>
      <P>The tone and voice from your PDF guide images and email layouts. Written copy follows your brand voice.</P>

      <H2 id="colours">Add your colours</H2>
      <Steps>
        <li>
          Open <Open href="/admin/brand-kit/colours">Brand › Colours</Open>.
        </li>
        <li>
          Under <strong>Build a palette</strong>, press <strong>Pull from website</strong>. You can also try{" "}
          <strong>Extract from PDF</strong>, <strong>Generate AI theme</strong> or <strong>From logo</strong>.
        </li>
        <li>
          Remove any colours you don&apos;t want, then press <strong>Add to Colour palette</strong>.
        </li>
        <li>
          Name your main colour &quot;Primary&quot; and your button colour &quot;Accent&quot;. Email style looks for these
          names.
        </li>
        <li>
          Press <strong>Save colours</strong>.
        </li>
      </Steps>

      <H2 id="fonts">Set your fonts</H2>
      <Steps>
        <li>
          Open <Open href="/admin/brand-kit/fonts">Brand › Fonts</Open>.
        </li>
        <li>
          Click <strong>Heading</strong>, choose its <strong>Font</strong> and press the tick. Do the same for{" "}
          <strong>Body</strong>. Each one saves by itself.
        </li>
        <li>
          Have your own font file? Press <strong>+</strong>, then <strong>Upload a font</strong>. WOFF2, WOFF, TTF or OTF, up
          to 5 MB.
        </li>
      </Steps>
      <P>Emails can use some of the listed fonts, but never a font you upload.</P>

      <H2 id="voice">Write your brand voice</H2>
      <P>
        This is how your brand writes. Posts, articles, launch and journey emails and Vizzy&apos;s drafts all follow it. Once
        saved, it&apos;s used instead of any voice set on a single programme.
      </P>
      <Steps>
        <li>
          Open <Open href="/admin/brand-kit/voice">Brand › Brand voice</Open>.
        </li>
        <li>
          Press <strong>Generate with AI</strong>. It reads your website and drafts a voice.
        </li>
        <li>
          Edit the <strong>Summary</strong>, the <strong>Do</strong> and <strong>Don&apos;t</strong> lists (one per line) and
          the <strong>Guidelines</strong>.
        </li>
        <li>
          Press <strong>Save brand voice</strong>.
        </li>
      </Steps>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>
          Brand › Logos shows your logo with a <strong>Primary</strong> badge.
        </li>
        <li>
          Brand › Colours lists your colours under <strong>Colour palette</strong>.
        </li>
        <li>
          On <Open href="/admin">Home</Open>, &quot;Add your logo&quot; and &quot;Set your brand voice&quot; are ticked.
        </li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          ["Upload a PNG, JPG or WebP image.", "Save your logo as a PNG or JPG and try again."],
          [
            "Set your Primary Domain in",
            <>
              Open <Open href="/admin/account">Settings › Sending</Open>, enter your website under <strong>Primary domain</strong>{" "}
              and press <strong>Save</strong>. Then try again.
            </>,
          ],
          ["Couldn't generate a brand voice", "Press Generate with AI again, or write the voice yourself."],
          ["Couldn’t find colours from that source", "Try another source, or add colours by hand with + Add colour."],
          ["That PDF is too large (max 14MB).", "Upload a smaller copy of the PDF, or fill in the fields by hand."],
          ["Extraction failed", "Press Re-extract, try another PDF, or fill in the fields by hand."],
        ]}
      />

      <NextPage slug="your-brand" />
    </article>
  );
}
