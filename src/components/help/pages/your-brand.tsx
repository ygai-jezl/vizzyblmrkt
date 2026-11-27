import { H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { isSearchNoteReadsEnabled } from "@/lib/search/flags";
import type { HelpBodyProps } from "@/lib/help/pages";
import { isBrandNotesQuestionsUiEnabled, isBrandNotesRestUiEnabled, isBrandNotesUiEnabled } from "@/lib/brandNotes/flags";
import { isCompetitorsUiEnabled } from "@/lib/competitors/flags";
import { isBlogHeroUiEnabled, isBrandImageStyleUiEnabled, isImageFormatsUiEnabled, isMoreStylesUiEnabled, isSiteFontsUiEnabled } from "@/lib/content/imageStyle/flags";

/**
 * With ideas in the words (`ideaWords`, isIdeaWordsEnabled()) a launch's emails are waitlist emails,
 * as Brand voice says. "Such as a launch or an award" is the general sense and stays. With
 * `searchNoteReads` (SEARCH_NOTE_READS_ENABLED, ADR-0025) a note that names a customer reaches an
 * article only through its subject.
 */
export default function YourBrandHelp({ ideaWords = isIdeaWordsEnabled(), searchNoteReads = isSearchNoteReadsEnabled() }: HelpBodyProps = {}) {
  const imageStyle = isBrandImageStyleUiEnabled();
  const competitors = isCompetitorsUiEnabled();
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
        This is how your brand writes. Posts, articles, {ideaWords ? "waitlist" : "launch"} and journey emails and Vizzy&apos;s drafts all follow it. Once
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
          {searchNoteReads ? (
            <P>
              A note ticked as naming a customer goes into an article only when it is linked to the article&apos;s subject, never
              because it is close in meaning, and Vizzy&apos;s search of your notes leaves it out. Link it to its subjects so the
              right articles still find it.
            </P>
          ) : null}
          {isBrandNotesQuestionsUiEnabled() ? (
            <P>
              {isBrandNotesRestUiEnabled()
                ? "Every blog article asks your team three new questions, written to avoid what you already have."
                : "When none of your notes fits a blog article, the article asks your team questions."}{" "}
              Each one is kept here as an open question, linked to the articles that asked it. Press <strong>Open questions</strong> to see them, and answer one in
              its box: it saves as you type, and every article that asked it can use the answer. Once answered, it is a note like
              any other, with its question above it.
            </P>
          ) : null}
          {isBrandNotesRestUiEnabled() ? (
            <P>
              Each note says how many articles used it and when. Once an article uses a note, it rests: other articles leave it
              out for 30 days, and after 3 articles it goes in only when someone adds it, so the same story doesn&apos;t spread
              across your blog. Change both numbers under <strong>How often a note goes in</strong>. Press{" "}
              <strong>Ready</strong>, <strong>Resting</strong> or <strong>Used up</strong> to see those notes, and{" "}
              <strong>Where it was used</strong> on a note to see its articles.
            </P>
          ) : null}
        </>
      ) : null}

      {competitors ? (
        <>
          <H2 id="competitors">Watch your competitors</H2>
          <P>
            Competitors watches the businesses you compete with. We read a competitor&apos;s sitemap, the list of pages a site
            publishes for search engines, and learn how their site is built: its sections, what its pages are about, and the
            pages worth knowing about, such as prices, locations or comparisons. Then we check their news or blog page every
            week for new posts, and their whole sitemap every month for pages they added or removed.
          </P>
          <Steps>
            <li>
              Open <Open href="/admin/brand-kit/competitors">Brand › Competitors</Open>.
            </li>
            <li>
              Type their website under <strong>Their website</strong>. Check the <strong>Name</strong>, then press{" "}
              <strong>Monitor</strong>.
            </li>
            <li>
              Wait while it reads their site. It shows how far it has got, and it carries on if you leave the page.
            </li>
            <li>
              Press <strong>Open</strong> to see <strong>How their site is built</strong>, their <strong>News page</strong> and,
              later, <strong>What changed</strong>.
            </li>
          </Steps>
          <P>
            The name goes on your brand map as an alternative, beside the ones you have. If you haven&apos;t saved your brand map
            yet, it waits there under Suggestions instead. On the brand map, an alternative you watch says{" "}
            <strong>Monitoring</strong>, and one you don&apos;t has a <strong>Monitor</strong> button next to{" "}
            <strong>Find</strong>.
          </P>
          <P>
            New posts and site changes show on the competitor&apos;s card and in <Open href="/admin/approvals">Review</Open>, until
            someone presses <strong>Mark seen</strong>. You can watch up to 10 competitors. We read only public pages, and we
            don&apos;t read a page their robots.txt asks robots to leave alone. If we can&apos;t find their sitemap or news page,
            paste it on the competitor&apos;s page.
          </P>
          <P>
            Some sites put a screen in front of them that turns away automated readers like ours. When this copy of YouGrow
            allows it, we read their news through Google instead: the card says <strong>news only, read through Google</strong>,
            we check their posts every week, and there are no monthly site checks because we can&apos;t see the rest of their
            site. Otherwise the competitor&apos;s page says we couldn&apos;t read it.
          </P>
          <P>
            When this copy of YouGrow joins Competitors to your strategy, this page and the Strategy tab on{" "}
            <Open href="/admin/brand-kit/map">Brand › Brand map</Open> share one list. Each card, and each competitor&apos;s page,
            has a group, the same groups the strategy uses, such as <strong>Does most of what you do</strong>. An admin picks it
            with <strong>Choose a group</strong> on either page, and the other shows it. <strong>Find competitors</strong> here runs
            the same search as on the Strategy tab, and counts the same way. What it finds waits under{" "}
            <strong>Suggested by the finder</strong>: press <strong>Monitor</strong> to watch one, or{" "}
            <strong>Not a competitor</strong> so it isn&apos;t suggested again.
          </P>
          <H2 id="competitor-articles">See what they write</H2>
          <P>
            When this copy of YouGrow reads their articles, a competitor&apos;s page has a <strong>What they write</strong> tab. We
            read each new post in full, and the newest 20 from before you started watching. When their site gives no dates, we take
            each post&apos;s date from their news page, so the newest are read first. Open an article to see what it covers
            and its angle, who it is written for, each result it reports in numbers with the sentence it came from, the sites it
            cites, what it asks the reader to do and which of their own pages it sends readers to. Dates, prices, product settings
            and made up examples don&apos;t count as results. A link that only names a company, such as an investor or a partner,
            shows under <strong>Also links to</strong> and doesn&apos;t count as a site they cite. A page that only lists other
            posts, such as a category page, is skipped. We keep what we found and short quotes, never the article itself, and read
            up to 200 articles a month for your brand.
          </P>
          <P>
            The tab&apos;s totals say when the articles read were published, who they are written for, what they ask for, and the
            pages they send readers to most, named by their own link words and the part of their site each sits in. On{" "}
            <strong>What changed</strong>, a card for new posts adds what they were once we have read them, for example &quot;2
            case studies, for SEO leads. Both ask for a free trial.&quot;
          </P>
          <P>
            When we improve how articles are read, the ones already read are read again while no new post is waiting, keeping 50
            of the month&apos;s reads for new posts. If reading one again finds nothing, it keeps what we found before.
          </P>
          <P>
            <strong>What they write about</strong>, on <Open href="/admin/brand-kit/competitors">Brand › Competitors</Open>,
            puts your brand map&apos;s subjects beside how many articles each competitor wrote on them in the last 90 days, and how
            many of each subject&apos;s questions you have answered, drafted or planned. Each subject says what that means:{" "}
            <strong>Gap</strong> when they write about it and you don&apos;t yet, <strong>Open</strong> when nobody does,{" "}
            <strong>Crowded</strong> when a new angle would stand out, or <strong>You lead</strong>. On a big brand map it lists the
            subjects they write about, then the open subjects with the most questions.
          </P>
          <P>
            Below the table are the subjects they write about that your map doesn&apos;t have. A competitor&apos;s news about
            itself, such as a launch or an award, isn&apos;t listed. One already waiting on your map says{" "}
            <strong>Suggested</strong>. An admin ticks the ones to keep and presses <strong>Add to my map</strong>. They move to{" "}
            <strong>On your map now</strong>, and the articles they came from count on their row in the table. When your brand map
            isn&apos;t split into subjects yet, the button is <strong>Suggest for my map</strong>, and you decide on them in your
            brand map&apos;s Suggestions.
          </P>
          <P>
            Press a subject in the table, or <strong>Plan it</strong> beside a Gap, Open or Crowded one, to open its{" "}
            <strong>Competitors on this</strong> box. <strong>Their questions</strong> lists questions their articles answer that
            the subject doesn&apos;t have yet. An admin presses <strong>Add</strong> on one, then <strong>Write this next</strong>{" "}
            starts an article on it. This works even for a subject with no questions of its own yet.
          </P>
          <P>
            On <Open href="/admin/brand-kit/map">Brand › Brand map</Open>, each subject in the Subjects list shows how many
            articles competitors wrote on it and what that means, and a subject&apos;s <strong>Competitors on this</strong> box
            shows who wrote on it, the angles they took and what <strong>Nobody has</strong>: your questions none of their articles
            answer, and kinds of article nobody has written on it. <strong>Suggest an angle</strong> opens Write this next on the
            best of those questions, with an angle that steers away from theirs. Their questions are there too, to add.
          </P>
          <P>
            Suggest an angle, blog research and the writer also read what competitors wrote on a subject, so a new article takes a
            different angle. A competitor&apos;s own numbers are never used as facts in your articles: only an outside source&apos;s
            number, checked again at its source.
          </P>
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
          ...(competitors
            ? ([
                ["You're already watching this site.", "Open it from Brand › Competitors instead of adding it again."],
                ["We couldn't find a sitemap for this site.", "Paste their sitemap or their news page on the competitor's page, under Settings or News page."],
                ["You can watch up to 10 competitors.", "Stop watching one under its Settings, then add the new one."],
                [
                  "Their site turns away automated readers like ours, so we couldn't read it.",
                  "Press Try again another day, as some sites let us in later. If it still says this, watch a different competitor.",
                ],
              ] as [string, string][])
            : []),
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
