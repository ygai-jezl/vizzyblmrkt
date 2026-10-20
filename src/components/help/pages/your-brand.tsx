import { H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";
import { isBrandNotesQuestionsUiEnabled, isBrandNotesUiEnabled } from "@/lib/brandNotes/flags";
import { isBlogHeroUiEnabled, isBrandImageStyleUiEnabled, isImageFormatsUiEnabled, isMoreStylesUiEnabled, isSiteFontsUiEnabled } from "@/lib/content/imageStyle/flags";

export default function YourBrandHelp() {
  const imageStyle = isBrandImageStyleUiEnabled();
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
        Reading a guidelines PDF adds the colours and fonts it finds to yours. It never removes or renames the ones you
        already have.
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
      {imageStyle ? (
        <P>
          Images can use a font you upload (TTF, OTF, WOFF or WOFF2).
          {isSiteFontsUiEnabled()
            ? " Without one, they use the fonts your website uses, or the closest free font. Press Check my site under Found on your site to see which."
            : ""}
        </P>
      ) : null}

      {imageStyle ? (
        <>
          <H2 id="image-style">Pick your image style</H2>
          <P>
            Every image Vizzy makes starts from your image style: social posts, eBook images, email images
            {isBlogHeroUiEnabled() ? " and the hero image on every blog article" : ""}. Anyone making an image can pick
            another style for that image only.
          </P>
          <Steps>
            <li>
              Open <Open href="/admin/brand-kit/image-style">Brand › Image style</Open>.
            </li>
            <li>
              Pick a <strong>Default style</strong>. Drawn styles (
              {isMoreStylesUiEnabled() ? "Product noir, Headline card, Data story, Type poster, Split card, Line art" : "Product noir, Headline card"})
              show your words exactly; painted styles show no words.
            </li>
            <li>
              Under <strong>Per channel</strong>, give a channel its own style if you want one.
            </li>
            <li>
              Choose your <strong>Accent</strong>, and whether social images carry your logo and the post&apos;s headline.
            </li>
            <li>
              Press <strong>Save</strong>.
            </li>
          </Steps>
          <P>
            Product noir is built from screens of your product. The first time you use it, you&apos;re asked for one to five
            screenshots, kept in <Open href="/admin/brand-kit/screenshots">Brand › Screenshots</Open>. Crop out customer
            names, emails and private numbers first.
          </P>
          {isMoreStylesUiEnabled() ? (
            <P>
              Data story draws a chart from numbers in your post or article. It only uses numbers written there, and never
              one the fact check couldn&apos;t trace. With fewer than two, you&apos;re asked to add yours, or it&apos;s made
              as a Type poster.
            </P>
          ) : null}
          {isImageFormatsUiEnabled() ? (
            <P>
              Formats work in any style. Pick <strong>Format</strong> next to Style on a post, the hero card or the eBook
              cover: a <strong>Portrait card</strong> (someone&apos;s words, their name and role), a{" "}
              <strong>Partner lockup</strong> (your logo and a partner&apos;s name) or a <strong>Report cover</strong>. The
              picture is a painted scene: never a person, and never a partner&apos;s logo.
            </P>
          ) : null}
        </>
      ) : null}

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

      {isBrandNotesUiEnabled() ? (
        <>
          <H2 id="seen">Add what your team has seen</H2>
          <P>
            What we&apos;ve seen holds your team&apos;s first-hand experience: customer stories, things you tested, mistakes you
            see, objections you hear, your own numbers, and where you disagree with common advice. A blog article uses a note
            when it fits the article&apos;s question, so it speaks from experience instead of only explaining.
          </P>
          <Steps>
            <li>
              Open <Open href="/admin/brand-kit/notes">Brand › What we&apos;ve seen</Open>.
            </li>
            <li>
              Answer the question under <strong>Add a note</strong>, in your own words. Press <strong>Another question</strong>{" "}
              for a different one.
            </li>
            <li>
              Check the <strong>Kind</strong> and the <strong>Subjects</strong> it suggests, then press <strong>Save note</strong>.
            </li>
            <li>
              Have a call transcript or a case study? Press <strong>Paste a call or document</strong>, tick the notes it finds
              and press <strong>Add ticked</strong>. The pasted text isn&apos;t kept.
            </li>
          </Steps>
          <P>
            Write one story, test or result per note. Name a customer only if they agreed, and tick the box that says so;
            otherwise articles keep them anonymous. The panels beside your notes show which kinds you have least of, and which
            subjects on your brand map have no note yet.
          </P>
          {isBrandNotesQuestionsUiEnabled() ? (
            <P>
              When none of your notes fits a blog article, the article asks your team questions. Each one is kept here as an open
              question, linked to the articles that asked it. Press <strong>Open questions</strong> to see them, and answer one in
              its box: it saves as you type, and every article that asked it can use the answer. Once answered, it is a note like
              any other, with its question above it.
            </P>
          ) : null}
        </>
      ) : null}

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
          ...(imageStyle
            ? ([
                ["is built from screens of your product", "Press Add screenshots, or Make it without a screenshot, or pick another style."],
                ["Can't be used in images. Upload it as TTF, OTF or WOFF.", "Upload the same font as a TTF, OTF or WOFF file."],
              ] as [string, string][])
            : []),
        ]}
      />

      <NextPage slug="your-brand" />
    </article>
  );
}
