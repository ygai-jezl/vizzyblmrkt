import { H1, H2, Lead, P, Pairs, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import { isPeopleNameEnabled } from "@/lib/audience/flags";
import { isFieldsEnabled } from "@/lib/audience/peopleFlags";
import { STANDARD_COLUMNS, STANDARD_HEADERS, STANDARD_WORDS } from "@/lib/crm/paste/columns";
import { isVizzyPasteEnabled } from "@/lib/crm/paste/flags";
import { PUBLIC_LIST, type PublicLink } from "@/lib/crm/paste/publicLists";
import { COMPANY_REMOVE, PASTE_MESSAGES, PASTE_NOTES, PASTE_TIMELINE, PASTE_WORDS, ROW_REASONS } from "@/lib/crm/paste/words";
import type { HelpBodyProps } from "@/lib/help/pages";
import { peopleArea } from "@/lib/nav/terms";

/**
 * /help/paste-a-list, shown only while RAISE_PASTE_ENABLED is on (with New person). Pasting into
 * Ask Vizzy shows while AUDIENCE_VIZZY_ADD_PERSON_ENABLED is on too (`vizzyPaste`), and the brand's
 * own fields while AUDIENCE_FIELDS_ENABLED is (`fields`); the How to drawer passes the shell's
 * answers. With People on (`people`) the area is People, as the sidebar says.
 *
 * Every word the sheet, the card and the messages show is quoted from src/lib/crm/paste/, so the
 * page says what the screen says. This page and the card are the only product copy that names the
 * kit (decision 9).
 */

const out = (l: PublicLink) => (
  <a href={l.url} target="_blank" rel="noopener noreferrer">
    {l.label}
  </a>
);

export default function PasteAListHelp({ people = isPeopleNameEnabled(), fields = isFieldsEnabled(), vizzyPaste = isVizzyPasteEnabled() }: HelpBodyProps = {}) {
  const area = peopleArea(people);
  return (
    <article>
      <H1>Paste a list</H1>
      <Lead>
        Paste rows from a sheet to add the people and firms on it in one go: investors, lenders, grant bodies, stockists or
        any other list. Pasted on People, no AI reads your rows: the app&apos;s own code does, and it shows you how it read
        each one before anyone is added.
      </Lead>
      <Meta items={["About 5 minutes", "Admins", "When you have a list of people or firms to reach"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>Admin access to your brand</li>
            <li>A sheet or a CSV file with a header row, such as Email, First Name or Website</li>
          </>
        }
        unlocks={
          <>
            <li>Up to 50 people and companies added with one approval</li>
            <li>Where you found them, kept on each one, so you can tell them</li>
          </>
        }
      />

      <H2 id="paste">Paste rows from a sheet</H2>
      <Steps>
        <li>
          Open <Open href="/admin/crm">{area}</Open> and press <strong>{PASTE_WORDS.button}</strong>, at the right of the tabs.
          Only admins see it.
        </li>
        <li>In your sheet, select the header row and the rows you want, copy them, and paste them into the box.</li>
        <li>
          Under <strong>{PASTE_WORDS.sourceLabel}</strong>, say where you found the list, such as a directory, a friend&apos;s
          sheet or an event.
        </li>
        <li>
          Press <strong>{PASTE_WORDS.read}</strong>.
        </li>
      </Steps>
      <P>
        Up to 50 rows at a time. Rows copied from Google Sheets, Excel or Numbers, a CSV file and a Markdown table all work, as
        long as the first row names the columns.
      </P>

      <H2 id="rows">What each row becomes</H2>
      <Pairs
        head={["The row has", "It becomes"]}
        rows={[
          ["An email or a phone", "A person, with their name if the row has one"],
          ["Only a firm's own web address", "A company, with its name if the row has one"],
          ["Neither", `Left out: "${ROW_REASONS.no_contact}"`],
        ]}
      />
      <P>
        A firm row keeps only the company name, its web address
        {fields ? " and your company fields" : ""}. The list says: &quot;{PASTE_NOTES.firms_left_out}&quot; Profile links are
        never kept, on any row. A row that repeats an earlier one is left out, so several partners at one firm make one
        company. Someone already in People, or a company already in Companies, is left as it is.
      </P>
      <P>
        For example, Fernhill Plants, a plant shop raising a loan, pastes six local lenders. Four rows have an email, so they
        become four people. Two have only the lender&apos;s web address, so they become two companies.
      </P>

      <H2 id="columns">Which columns are read</H2>
      <P>
        Each column is read by its header, ignoring capitals, spaces and punctuation, and a plural s. A column that isn&apos;t
        read shows under <strong>{PASTE_WORDS.columnsLeft}</strong> and nothing in it is kept.
      </P>
      <Pairs head={["Read as", "Headers"]} rows={STANDARD_COLUMNS.map((c) => [STANDARD_WORDS[c], STANDARD_HEADERS[c].join(", ")])} />
      <UL>
        <li>
          <strong>Name</strong> is split at its first space, and used only when there is no First Name or Last Name.
        </li>
        <li>Profile links are never kept: any column with LinkedIn, Twitter, Facebook, Instagram, Crunchbase or AngelList in its header, and Profile, Profile Url, Profile Link, Social or Socials.</li>
        <li>
          A firm&apos;s web address must be its own site. A short link, or a page on a site many firms share, such as Google
          Sites, a site builder or a newsletter host, is left out, so firms there never become one company.
        </li>
        {fields ? (
          <li>
            Any other column whose header is the name of one of your own fields fills that field: a People field on a person, a
            company field on a company. A firm row never fills a field from a person&apos;s name, title, role, city, state or
            country. Business, Shop and Store fill your own field of that name if you have one, and name the firm otherwise.
            When two columns name one field, each row keeps the first of their cells that fits it, so your own Stage column
            and the kit&apos;s Stages column both work, in either order.
          </li>
        ) : null}
      </UL>
      <P>
        From The AI Fundraising Kit: Company Name and Website are kept. First Name and Last Name are kept only on a row where
        you added an email or a phone yourself, and the LinkedIn columns are never kept.
        {fields
          ? " Title and the investor's city, state and country fill People fields of those names on a person. Stages, Sectors, Fund HQ and the investment counts fill company fields of those names on a company. On a person, a Stages cell such as Seed fills a People field named Stage only when Seed is one of its options."
          : ""}
      </P>

      <H2 id="source">Where the list is from</H2>
      <P>
        Your answer to <strong>{PASTE_WORDS.sourceLabel}</strong> is kept on each person and company it adds, on their
        timeline, and in a person&apos;s export. It is how you can tell someone where you found their details when you first
        write to them. {PUBLIC_LIST.guidance[2]}
      </P>

      <H2 id="add">Add them in one go</H2>
      <Steps>
        <li>
          Check what the list shows: how each column was read, each row it adds and as what, and each row left out with its row
          number and why.
        </li>
        <li>
          Press <strong>Add</strong>, which says how many, such as <strong>Add 10 people and 3 companies</strong>. Or press{" "}
          <strong>{PASTE_WORDS.dismiss}</strong> to add nobody.
        </li>
      </Steps>
      <P>
        Until you press Add, the list waits as one card in <Open href="/help/review-and-approvals#what">Review</Open>, under
        Pasted lists, for any admin to open. {PASTE_WORDS.waits} The card keeps only the rows it will add; the rows left out
        are kept nowhere.
      </P>
      <P>
        {PASTE_NOTES.not_yet} Each person&apos;s <Open href="/help/your-audience#timeline">timeline</Open> says &quot;
        {PASTE_TIMELINE.text}&quot; with the day, who added it and where it is from.
      </P>

      <H2 id="public-list">{PUBLIC_LIST.title}</H2>
      <P>
        Raising money and not sure who to ask? Under the box, <strong>{PUBLIC_LIST.summary}</strong> opens a short guide.{" "}
        {PUBLIC_LIST.body}
      </P>
      <P>
        {PUBLIC_LIST.credit} {out(PUBLIC_LIST.kit)}.
      </P>
      <Steps>
        {PUBLIC_LIST.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </Steps>
      <P>
        {PUBLIC_LIST.othersTitle}:{" "}
        {PUBLIC_LIST.others.map((o, i) => (
          <span key={o.url}>
            {i ? (i === PUBLIC_LIST.others.length - 1 ? " and " : ", ") : null}
            {out(o)}
          </span>
        ))}
        . {PUBLIC_LIST.othersHint}
      </P>
      <UL>
        {PUBLIC_LIST.guidance.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </UL>
      <P>{PUBLIC_LIST.footnote}</P>

      {vizzyPaste ? (
        <>
          <H2 id="vizzy">Paste into Ask Vizzy</H2>
          <P>
            You can also paste the table into Ask Vizzy, for example &quot;Here are my 20 target funds&quot; followed by the rows.
            Vizzy sees the rows you paste in the chat and passes them, as pasted, to the same code that reads the box. It asks
            where the list is from if you haven&apos;t said, and the code reads it into the same card. Open it from the chat or
            from Review to check it and press Add. Vizzy never records that anyone agreed to emails, and never adds or changes
            a row. What you paste stays in your chat history, like anything you type there. Only admins can.
          </P>
        </>
      ) : null}

      <H2 id="remove">Remove a company</H2>
      <P>
        A company with no people, such as a firm you added from a list and no longer want, can be removed: open it on the
        Companies tab and press <strong>{COMPANY_REMOVE.button}</strong>. Its own fields and history go with it. Only admins
        can.
      </P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>The people you added are in People, each at Not yet for marketing emails.</li>
        <li>The firms you added are on the Companies tab.</li>
        <li>A person&apos;s page says {PASTE_TIMELINE.text}, with where it is from.</li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [ROW_REASONS.no_contact, "Add an email or a phone for a person, or the firm's own web address for a company, then paste the row again."],
          [ROW_REASONS.bad_email, "Fix the address in your sheet and paste the row again."],
          [ROW_REASONS.bad_phone, "Use digits, with + and spaces if you like, then paste the row again."],
          [ROW_REASONS.not_a_firm_site, "Put the firm's own website in the row, not its LinkedIn, Notion or directory page, a short link or a page on a shared site."],
          [ROW_REASONS.repeated, "Nothing to do: the earlier row is the one added."],
          [ROW_REASONS.in_people, "Nothing to do: they are left as they are. Open their page to change anything."],
          [ROW_REASONS.in_companies, "Nothing to do: the company is left as it is."],
          [PASTE_MESSAGES.source_needed, `Fill in ${PASTE_WORDS.sourceLabel} and press ${PASTE_WORDS.read} again.`],
          [PASTE_MESSAGES.no_header, "Copy the header row too, as the first line, and paste again."],
          [PASTE_MESSAGES.too_many_rows, "Paste the first 50 rows, add them, then paste the rest."],
          [PASTE_MESSAGES.too_many_columns, "Hide or delete the columns you don't need before you copy."],
          [PASTE_MESSAGES.too_long, "Paste fewer rows or columns at a time."],
          [PASTE_MESSAGES.too_large, "Leave out long text columns such as notes, or paste fewer rows."],
          [PASTE_MESSAGES.nothing_to_add, "Check the rows left out and why, fix them in your sheet, and paste them again."],
          [PASTE_MESSAGES.paste_gone, "Paste the list again if you still want to add it."],
          [PASTE_MESSAGES.changed, "Reload the page to see whether the list was added."],
          [COMPANY_REMOVE.has_people, "Erase its people from their pages first, or keep the company."],
        ]}
      />

      <NextPage slug="paste-a-list" />
    </article>
  );
}
