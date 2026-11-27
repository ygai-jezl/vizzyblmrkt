import { H1, H2, Lead, P, Pairs, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import type { HelpBodyProps } from "@/lib/help/pages";
import { PRESENT_WORDS, CHECK_WORDS, LABEL_WORDS, LIST_WORDS, NUMBER_DIALOG, PDF_WORDS, RAISE_MESSAGES, SLIDE_RULES, STUDIO_WORDS, UK_PROMOTION_REMINDER } from "@/lib/raise/docs/words";

/**
 * /help/raise-kit (RAISE_KIT_ENABLED): decks for investors and packs for lenders. Every label and
 * message comes from src/lib/raise/docs/words.ts, so the page says what the screens say. The How to
 * drawer passes `ideaWords` for the Next link.
 */
export default function RaiseKitHelp({ ideaWords }: HelpBodyProps = {}) {
  return (
    <article>
      <H1>Raise kit</H1>
      <Lead>
        Draft a deck for investors or a pack for lenders from what YouGrow already knows about your business, rehearse its
        talk track, present it and save it as a PDF. Every number on a slide says where it came from.
      </Lead>
      <Meta items={["About 10 minutes for a first draft", "Admins make and change decks, everyone can present", "Whenever you raise or borrow"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>
              Your <Open href="/help/brand-map">brand map</Open>, so Vizzy knows who you serve and what you do
            </li>
            <li>
              Your product connected, if you have one (<Open href="/help/connect-your-product">Connect your product</Open>), so
              Vizzy can read what it does from its repo
            </li>
            <li>The Raise kit in your brand&apos;s plan</li>
          </>
        }
        unlocks={
          <>
            <li>A first draft in about a minute, with Needs where something is missing</li>
            <li>A talk track you can rehearse against a timer</li>
            <li>A PDF with one slide a page, ready to send</li>
          </>
        }
      />

      <H2 id="make">Make a first draft</H2>
      <Steps>
        <li>
          Open <Open href="/admin/workspace">Content</Open> and choose <strong>Open Raise kit</strong>, or go straight to{" "}
          <Open href="/admin/raise">Raise kit</Open>.
        </li>
        <li>
          Under <strong>{LIST_WORDS.legend}</strong>, choose <strong>{LIST_WORDS.investor}</strong> ({LIST_WORDS.preSeed} or{" "}
          {LIST_WORDS.seed}) or <strong>{LIST_WORDS.lender}</strong>.
        </li>
        <li>
          Add anything Vizzy should know in <strong>{LIST_WORDS.brief}</strong>, such as what the money is for.
        </li>
        <li>
          Choose <strong>{LIST_WORDS.make}</strong>. The deck opens when the draft is ready.
        </li>
      </Steps>
      <P>
        Vizzy reads your website, your repo, your brand map, your brand strategy, your competitors, your team list, what you told it
        in About your business, and your sign-ups. Where it can&apos;t find something, the slide shows a Needs callout, such as
        &quot;Needs: team bios. Add it here or tell Vizzy.&quot; Needs show only while you edit: they never present or print.
      </P>
      <P>
        You can also ask Vizzy in the chat, for example &quot;Make me a 10 slide pre-seed deck&quot; or &quot;Make a lender pack for a
        stock loan&quot;. Vizzy saves a draft and gives you a card to open it. Nothing is sent or shared.
      </P>

      <H2 id="numbers">Where every number comes from</H2>
      <P>{SLIDE_RULES[1]} Numbers are never written into a slide&apos;s words by hand or by Vizzy: each one is a chip that comes from its own record, with a label and a date.</P>
      <Pairs
        head={["Label", "What it means"]}
        rows={[
          [`${LABEL_WORDS.seen}, 26 Nov`, "YouGrow counted it from your own data on that date, such as your sign-ups in the last 12 weeks."],
          [`${LABEL_WORDS.typed}, 26 Nov`, "Someone on your team typed it, with where it came from if they said. YouGrow doesn't check it."],
          [LABEL_WORDS.saidInChat, "You told Vizzy the number in the chat, and Vizzy kept your own words with it."],
        ]}
      />
      <UL>
        <li>
          Choose <strong>{NUMBER_DIALOG.title}</strong> under the slide to add sign-ups, sign-up growth, the people on one of your
          waitlists, or a number you type, such as monthly sales from your till.
        </li>
        <li>Sign-ups count as Insights counts them. A deck never shows everyone in People, which can include investors and partners.</li>
        <li>
          Each version keeps the numbers it showed. Choose <strong>{STUDIO_WORDS.more}</strong>, then{" "}
          <strong>{STUDIO_WORDS.refresh}</strong>, to count them again as a new version.
        </li>
      </UL>

      <H2 id="edit">Change it slide by slide</H2>
      <UL>
        <li>Pick a slide on the left, then change its headline, points, columns, people or speaker notes under it.</li>
        <li>
          Use <strong>{STUDIO_WORDS.addSlide}</strong>, <strong>{STUDIO_WORDS.moveUp}</strong>, <strong>{STUDIO_WORDS.moveDown}</strong>{" "}
          and <strong>{STUDIO_WORDS.removeSlide}</strong> to change the order.
        </li>
        <li>
          Choose <strong>{STUDIO_WORDS.save}</strong>. Add a line in <strong>{STUDIO_WORDS.whatChanged}</strong>, or YouGrow writes one,
          such as &quot;Changed slide 3 headline.&quot;
        </li>
        <li>
          Or type in <strong>{STUDIO_WORDS.ask}</strong> below the slide, such as &quot;lead with the weekly growth&quot;. Vizzy saves its
          change as a new version.
        </li>
      </UL>
      <P>
        Every change is a new version with its note. Choose <strong>{STUDIO_WORDS.more}</strong>, then{" "}
        <strong>{STUDIO_WORDS.versions}</strong>, to view one, or <strong>{STUDIO_WORDS.putBack}</strong>, which saves it again as the
        newest version. {STUDIO_WORDS.versionsFoot}
      </P>

      <H2 id="checks">Checks</H2>
      <P>
        The <strong>{STUDIO_WORDS.tabs.checks}</strong> tab lists hints for the slide and the whole deck, and a dot marks each slide
        with one. {SLIDE_RULES[0]} Checks never stop you saving, presenting or saving a PDF.
      </P>
      <Messages
        rows={[
          [CHECK_WORDS.headline_label, "Write the headline as the point you want people to remember."],
          [CHECK_WORDS.missing_why_now, "Add a Why now slide with Add slide."],
          [CHECK_WORDS.missing_ask, "Add an ask slide with how much you're raising."],
          [CHECK_WORDS.missing_repayment, "Add a How it repays slide that shows how repayments fit your sales."],
          [CHECK_WORDS.terms_on_ask, "Take the valuation and terms off the slide and talk them through in the meeting."],
          [CHECK_WORDS.cumulative_chart, "Type each week's or month's own figure, not the running total."],
          [CHECK_WORDS.chart_no_source, "Fill in where it's from when you type the numbers."],
        ]}
      />

      <H2 id="talk-track">Talk track and rehearsing</H2>
      <P>
        The speaker notes under each slide are your talk track. The <strong>{STUDIO_WORDS.tabs.talk}</strong> tab says how many words a
        slide and the whole deck have, and about how long they take at 150 words a minute. That is our estimate: people speak
        faster or slower.
      </P>
      <P>
        Choose <strong>{STUDIO_WORDS.rehearse}</strong> to open Present with the notes and the timer on. The slide&apos;s time turns
        amber once it runs over.
      </P>

      <H2 id="present">Present</H2>
      <P>
        Choose <strong>{STUDIO_WORDS.present}</strong>. The deck fills the screen.
      </P>
      <Pairs
        head={["Key", "What it does"]}
        rows={[
          ["Right arrow, Space or Page Down", "Next slide"],
          ["Left arrow or Page Up", "Back a slide"],
          ["N", `Shows or hides the speaker notes and the timer (${PRESENT_WORDS.notes})`],
          ["T", "Starts the timer again"],
          ["Esc", "Leaves Present"],
        ]}
      />

      <H2 id="pdf">Save as PDF</H2>
      <Steps>
        <li>
          Choose <strong>{STUDIO_WORDS.savePdf}</strong>, read <strong>{PDF_WORDS.title}</strong>, then choose{" "}
          <strong>{PDF_WORDS.save}</strong>.
        </li>
        <li>In the print window, choose Save as PDF. Chrome or Edge give the cleanest PDF.</li>
      </Steps>
      <P>
        You get one slide a page, so a pre-seed deck is 10 pages. The words stay real text, so whoever reads it can search and
        copy them. Needs callouts don&apos;t print.
      </P>
      <Messages
        rows={[
          [UK_PROMOTION_REMINDER, "Check with your lawyer which exemption applies before you send it. YouGrow shows this before every investor deck is saved as a PDF."],
        ]}
      />
      <P>A lender pack shows no reminder, since a loan isn&apos;t an investment.</P>

      <H2 id="shop">A shop or any business: the lender pack</H2>
      <P>
        Fernhill Plants, a made up plant shop, wants a loan for spring stock. It chooses <strong>{LIST_WORDS.lender}</strong> and gets 5
        slides: the cover, sales, what the money is for, how it repays, and who runs the shop.
      </P>
      <UL>
        <li>On the sales slide, the owner types the till&apos;s monthly sales: &quot;£14,200 a month, Typed by you, from the shop&apos;s till&quot;.</li>
        <li>The people on its newsletter list come from YouGrow: &quot;2,300, Seen by YouGrow, 26 Nov&quot;.</li>
        <li>Both figures are made up for this example.</li>
      </UL>

      <H2 id="data">Search, download and delete</H2>
      <UL>
        <li>Brand search finds each slide by its words, and opens the deck on that slide.</li>
        <li>
          <strong>{STUDIO_WORDS.download}</strong>, under <strong>{STUDIO_WORDS.more}</strong>, saves the deck and its kept versions as a file.
        </li>
        <li>
          <strong>{STUDIO_WORDS.delete}</strong> removes the deck and every version for good.
        </li>
        <li>Admins make and change decks. Everyone on the team can open, present and save one as a PDF.</li>
      </UL>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>The cover shows your logo and your brand&apos;s colour.</li>
        <li>The traction slide&apos;s numbers read Seen by YouGrow with today&apos;s date.</li>
        <li>Save as PDF gives one page for each slide.</li>
      </Checks>

      <H2 id="messages">Messages you might see</H2>
      <Messages
        rows={[
          [RAISE_MESSAGES.notIncluded, "Ask whoever runs your YouGrow to add it to your plan. Decks you already made still open, present and save as PDF."],
          [RAISE_MESSAGES.rateLimited, "Wait a few minutes, then choose Make the first draft again."],
          [RAISE_MESSAGES.outlineOnly, "Fill in the slides yourself, or make a new draft later."],
          [RAISE_MESSAGES.stale, "Reload the page, then make your change again on the newest version."],
          [RAISE_MESSAGES.deckLimit, "Delete a deck you no longer need, then make the new one."],
          [RAISE_MESSAGES.memberOnly, "Ask an admin on your team to make the change."],
        ]}
      />

      <NextPage slug="raise-kit" ideaWords={ideaWords} />
    </article>
  );
}
