import { H1, H2, Lead, P, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import { isPeopleNameEnabled } from "@/lib/audience/flags";
import { isAddPersonEnabled, isFieldFiltersEnabled, isFieldsEnabled, isTimelineEnabled } from "@/lib/audience/peopleFlags";
import { TIMELINE_EMPTY } from "@/lib/audience/timelineWords";
import { FIELD_MESSAGES } from "@/components/admin/audience/fieldsApi";
import { CONSENT_WAYS, NEW_PERSON_MESSAGES, NEW_PERSON_NOTES } from "@/lib/audience/newPerson";
import type { HelpBodyProps } from "@/lib/help/pages";
import { peopleArea } from "@/lib/nav/terms";

/**
 * Shown only while AUDIENCE_ONE_VIEW_ENABLED is on (src/lib/help/pages.ts). With People on
 * (NEXT_PUBLIC_NAV_PEOPLE_ENABLED) the area is People, as the sidebar says; the slug stays. The
 * fields sections show while AUDIENCE_FIELDS_ENABLED is on, and the filters section while
 * AUDIENCE_FIELD_FILTERS_ENABLED is too. Adding someone by hand shows while
 * AUDIENCE_ADD_PERSON_ENABLED is on, and the timeline while AUDIENCE_TIMELINE_ENABLED is.
 */
export default function YourAudienceHelp({
  people = isPeopleNameEnabled(),
  fields = isFieldsEnabled(),
  fieldFilters = isFieldFiltersEnabled(),
  addPerson = isAddPersonEnabled(),
  timeline = isTimelineEnabled(),
}: HelpBodyProps = {}) {
  const area = peopleArea(people);
  return (
    <article>
      <H1>{people ? "People" : "Your audience"}</H1>
      <Lead>
        Everyone you know, in one list: people who joined a launch, people from your own site&apos;s sign-up box, and the
        users of your connected products. One row and one page per person, whatever brought them.
      </Lead>
      <Meta
        items={[
          "2 minutes",
          fields || addPerson
            ? `Anyone on your team; erasing, exporting${addPerson ? ", adding people" : ""}${fields ? " and changing fields" : ""} are for admins`
            : "Anyone on your team; erasing and exporting are for admins",
          "Whenever you need it",
        ]}
      />

      <BeforeAndUnlocks
        before={
          <>
            <li>
              A <Open href="/help/launch-and-waitlist">launch</Open> with sign-ups, or a{" "}
              <Open href="/help/connect-your-product">connected product</Open> that has sent its users
            </li>
          </>
        }
        unlocks={
          <>
            <li>Seeing how many people you have, and how many you can email</li>
            <li>One page for each person, with their launches and their product together</li>
            <li>Erasing or exporting a person everywhere at once</li>
            {fields ? <li>Your own fields on people and companies, with every change kept</li> : null}
            {addPerson ? <li>Adding someone you met by hand, with how they agreed to hear from you</li> : null}
          </>
        }
      />

      <H2 id="list">The People list</H2>
      <Steps>
        <li>
          Open <Open href="/admin/crm">{area}</Open>. {people ? "Its" : "The"} <strong>People</strong> tab lists everyone,
          most recently active first, with the total at the bottom.
        </li>
        {fieldFilters ? (
          <li>
            Pick who to show at the top: <strong>Everyone</strong>, or one launch, product or stage from the{" "}
            <strong>Launch</strong>, <strong>Product</strong> and <strong>Stage</strong> menus. Stages are{" "}
            <strong>New</strong>, <strong>Onboarding</strong>, <strong>Stuck</strong>, <strong>Activated</strong> and{" "}
            <strong>Quiet</strong>.
          </li>
        ) : (
          <li>
            Pick a group at the top: <strong>Everyone</strong>, one of your launches, <strong>From your site</strong>, or one
            of your products. A product also shows its stages: <strong>New</strong>, <strong>Onboarding</strong>,{" "}
            <strong>Stuck</strong>, <strong>Activated</strong> and <strong>Quiet</strong>.
          </li>
        )}
        <li>
          {fieldFilters ? "Press" : "Tick"} <strong>Only people we can email</strong> to leave out anyone who unsubscribed,
          bounced or never gave consent.
        </li>
        <li>Or search everyone by name, email or domain.</li>
      </Steps>
      <P>
        The same email address is the same person, so someone who joined your waitlist and then signed up to your product
        is one row. Someone who only gave a phone number is a person of their own. A sign-up from your own site joins the
        list once they confirm their email.
      </P>

      {fieldFilters ? (
        <>
          <H2 id="filters">Filter by a field or a group</H2>
          <Steps>
            <li>
              On the People list, open the menu named after one of <Open href="/help/your-audience#fields">your fields</Open>.
              Select, multi select, status and checkbox fields each have one, and its counts load when it opens.
            </li>
            <li>
              Pick a value. The list shows everyone with it, and the line above says how many. A multi select finds everyone who
              has that option among theirs; a checkbox finds everyone ticked.
            </li>
            <li>Press the filter to clear it. One filter applies at a time, with or without Only people we can email.</li>
          </Steps>
          <P>
            To see everyone in one of your product&apos;s groups, such as a workspace, open someone in it and press{" "}
            <strong>Everyone in this group</strong> under <strong>Product groups</strong>.
          </P>
          <P>
            An archived field or option leaves the menus, and the people who had it keep it: bring it back and its filter returns.
          </P>
        </>
      ) : null}

      {addPerson ? (
        <>
          <H2 id="add">Add someone by hand</H2>
          <Steps>
            <li>
              On the People list press <strong>New person</strong>, or pick <strong>New person</strong> under Create in the search box
              (⌘K). Only admins can.
            </li>
            <li>
              Type their email, or leave it empty and type a phone number, then their name. A work address shows the company it
              matches.{fields ? " Fill in any of your own fields; More of your fields shows the rest." : ""}
            </li>
            <li>
              Under <strong>Marketing emails</strong>, leave <strong>Not yet</strong>, or pick <strong>They agreed</strong> and say how:{" "}
              {CONSENT_WAYS.map((w, i) => (
                <span key={w.how}>
                  {i ? (i === CONSENT_WAYS.length - 1 ? " or " : ", ") : null}
                  <strong>{w.label}</strong>
                </span>
              ))}
              . Other needs a short note. Your name and the time are saved with it. Joining a list never counts as agreeing.
            </li>
            <li>
              Press <strong>Add person</strong>. Their page opens. If their email or phone is already in People, you go to that person
              instead and nothing is added.
            </li>
          </Steps>
          <P>
            On the page of someone added by hand, <strong>Consent, in one place</strong> says who added them and whether they agreed. An
            admin can press <strong>Record that they agreed</strong> later. Consent for people from a launch or your product comes from
            there, not from here.
          </P>
          <P>
            For someone added by hand, can email means your team recorded that they agreed. Nothing is sent to them yet: journeys and
            broadcasts reach people added by hand once lists come. They stay in People whatever happens to their launches or products,
            keep the name you typed, and are exported and erased like anyone else.
          </P>
          <P>
            Someone added with only a phone is their own person. If they later sign up with an email, that sign-up becomes a separate
            person. People added by hand count towards your plan&apos;s people; near or over the limit the form says so and still adds
            them.
          </P>
        </>
      ) : null}

      <H2 id="person">One person&apos;s page</H2>
      <P>Click a row to open everything about them:</P>
      <UL>
        <li>
          <strong>Launches</strong>: each launch they joined, whether they confirmed, their referrals, their invite and their
          waitlist journey.
        </li>
        <li>
          Each <strong>product</strong> they use: their steps, journeys, emails and story, as on{" "}
          <Open href="/help/people">one person&apos;s view</Open>.
        </li>
        <li>
          <strong>Emails from your launches</strong>, and <strong>Consent, in one place</strong>: whether you can email
          them and why not.
        </li>
        {timeline ? (
          <li>
            Their <Open href="/help/your-audience#timeline">timeline</Open>, beside the rest.
          </li>
        ) : null}
      </UL>

      {timeline ? (
        <>
          <H2 id="timeline">The timeline</H2>
          <P>A person&apos;s page shows what happened to them, newest first. Press <strong>Show older</strong> for more.</P>
          <UL>
            <li>joining a launch&apos;s waitlist, and leaving it;</li>
            <li>starting to use one of your products, moving from one stage to another in it, going quiet and coming back;</li>
            <li>the emails your launches sent them, and what they did with them;</li>
            <li>a voice chat on a sign-up page, which an admin can read;</li>
            {addPerson ? <li>being added by hand, and agreeing to marketing emails;</li> : null}
            {fields ? <li>each change to your own fields, with who made it and the values before and after;</li> : null}
            <li>what Vizzy suggested, and what came of it.</li>
          </UL>
          <P>
            Moves are recorded from the day the timeline was turned on in your copy of YouGrow; nothing from before then is added.
            What they did inside a product stays in that product&apos;s part of their page. Anyone on your team can read the
            timeline. It is in their export, and erasing them removes it; erasing them from one product removes that
            product&apos;s moves.
          </P>
        </>
      ) : null}

      {fields ? (
        <>
          <H2 id="fields">Your own fields</H2>
          <Steps>
            <li>
              Open <Open href="/admin/account/data-model">Settings, then Data model</Open>. <strong>People</strong> is picked; pick{" "}
              <strong>Companies</strong> for <Open href="/help/your-audience#company-fields">company fields</Open>.
            </li>
            <li>
              In <strong>Add field</strong>, type a name and pick a type: text, number, currency, date, checkbox, select, multi select,
              status, email, phone, link or team member. A type is fixed once the field is made. Select, multi select and status need
              their options, one per line, and currency needs its code, such as GBP.
            </li>
            <li>
              Press <strong>Add field</strong>. It shows on every person&apos;s page under <strong>Fields</strong>, where an admin presses{" "}
              <strong>Edit</strong> beside it to set a value. A team member field lists the people on your team.
            </li>
          </Steps>
          <P>
            To rename a field, add or archive an option, or change its type, press <strong>Edit</strong> beside it in Data model.
            Changing the type makes a new field with the same name and archives the old one with its values.{" "}
            <strong>Archive field</strong> hides a field and keeps every value on each person; <strong>Bring back</strong> under{" "}
            <strong>Archived</strong> returns it, values and all. Nothing is ever deleted.
          </P>
          <P>
            <strong>Changes</strong> lists every change to the list, with who made it and when. Someone who has left your team shows as
            Former team member. Restoring an older list comes with settings history.
          </P>
          <P>Beside your own fields, a person&apos;s page shows fields from elsewhere, read only, each with where it comes from:</P>
          <UL>
            <li>their answers to a launch&apos;s sign-up questions, labelled with the launch;</li>
            <li>each product&apos;s stage for them, and the traits and facts your product sends;</li>
            <li>their company&apos;s size, from company enrichment;</li>
            <li>
              a voice chat on a sign-up page: its summary, which their browser sent when the chat ended and nobody has checked. An admin
              can press <strong>Read the conversation</strong> to read what was said.
            </li>
          </UL>
          <P>
            Admins change fields and values; everyone else on your team can read them. A person&apos;s export lists their values with
            each field&apos;s name, archived ones marked, and erasing them removes their values and every change. A list holds up to 100
            fields in use, 300 in all, and 50 options a field.
          </P>

          <H2 id="company-fields">Company fields</H2>
          <P>
            Pick <strong>Companies</strong> in Data model to add fields to companies, the same way. Open a company from the{" "}
            <strong>Companies</strong> tab in <Open href="/admin/crm">{area}</Open> to see and edit them under{" "}
            <strong>Company fields</strong>. A company&apos;s values go when its last person is erased.
          </P>
        </>
      ) : null}

      <H2 id="stages">How stages are read</H2>
      <P>
        Each product puts its users in a stage with three clocks: New for the first 2 days, Stuck after 7 days on one step,
        Quiet after 14 days without using the product. Change them for one product on its <strong>Settings</strong> tab,
        under <strong>How we read stages</strong>, in{" "}
        <Open href="/admin/products">Products</Open>. Stages move on the next check, within a few minutes.
      </P>

      <H2 id="erase">Export or erase someone</H2>
      <P>
        On their page, an admin can press <strong>Export their data</strong> for a file of everything held about them, or{" "}
        <strong>Erase everywhere</strong>. Erasing deletes their sign-ups on every launch, their user record in every
        product, their journeys and their email history. Their unsubscribe keeps working, without their address. It
        can&apos;t be undone.
      </P>
      <P>
        To remove them from one product only, press <strong>Erase from this product</strong> in that product&apos;s part
        of their page. Their launches stay.
      </P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>Someone who signed up to a launch appears in People, under that launch.</li>
        <li>The same email sent by your product shows on the same row, with the product beside the launch.</li>
        {addPerson ? <li>Someone you add by hand shows in People marked Added by hand, and adding them again opens their page.</li> : null}
        {timeline ? <li>After a stage moves in your product, the person&apos;s timeline shows the move.</li> : null}
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          ["Nobody in this group yet.", "Pick another group, or wait for people to sign up or for your product to send them."],
          [
            "New has to end before Stuck starts: make New fewer days than Stuck.",
            "On How we read stages, make New a smaller number of days than Stuck, then save.",
          ],
          [
            "Erasing them everywhere. It finishes within a few minutes; then this page finds nobody.",
            "Nothing to fix. The erase runs in the background; reload the page in a few minutes.",
          ],
          ...(fields
            ? ([
                [FIELD_MESSAGES.fields_changed, "Reload the page, then make your change again on top of theirs."],
                [FIELD_MESSAGES.field_list_full, "Archive fields you no longer use, or a field with fewer options. Archived fields and options still count towards the total."],
                [FIELD_MESSAGES.not_on_team, "They left your team, so pick someone who is, or Nobody."],
                [FIELD_MESSAGES.archived_field, "Someone archived the field while you were editing. Reload the page; Bring back returns it."],
              ] as Array<[string, string]>)
            : []),
          ...(addPerson
            ? ([
                [NEW_PERSON_MESSAGES.email_or_phone, "Type an email address, or a phone number for someone with no email."],
                [NEW_PERSON_MESSAGES.note_needed, "With Other picked, say in a few words how they agreed."],
                [NEW_PERSON_MESSAGES.consent_elsewhere, "Nothing to fix. Their consent shows under Consent, in one place, from their launch or product."],
                [NEW_PERSON_MESSAGES.fields_not_saved, "Open their page and set the values in Fields."],
                [NEW_PERSON_NOTES.nothingSent, "Nothing to fix. People added by hand get emails once lists reach them."],
                ["You can still add people.", "Nothing to fix now. See Plan and usage for your plan's people."],
              ] as Array<[string, string]>)
            : []),
          ...(timeline ? ([[TIMELINE_EMPTY, "Nothing to fix. Their timeline fills as things happen to them."]] as Array<[string, string]>) : []),
        ]}
      />

      <NextPage slug="your-audience" />
    </article>
  );
}
