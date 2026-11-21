import { H1, H2, Lead, P, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import { isPeopleNameEnabled } from "@/lib/audience/flags";
import { isFieldsEnabled } from "@/lib/audience/peopleFlags";
import { FIELD_MESSAGES } from "@/components/admin/audience/fieldsApi";
import type { HelpBodyProps } from "@/lib/help/pages";
import { peopleArea } from "@/lib/nav/terms";

/**
 * Shown only while AUDIENCE_ONE_VIEW_ENABLED is on (src/lib/help/pages.ts). With People on
 * (NEXT_PUBLIC_NAV_PEOPLE_ENABLED) the area is People, as the sidebar says; the slug stays. The
 * fields sections show while AUDIENCE_FIELDS_ENABLED is on.
 */
export default function YourAudienceHelp({ people = isPeopleNameEnabled(), fields = isFieldsEnabled() }: HelpBodyProps = {}) {
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
          fields ? "Anyone on your team; erasing, exporting and changing fields are for admins" : "Anyone on your team; erasing and exporting are for admins",
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
          </>
        }
      />

      <H2 id="list">The People list</H2>
      <Steps>
        <li>
          Open <Open href="/admin/crm">{area}</Open>. {people ? "Its" : "The"} <strong>People</strong> tab lists everyone,
          most recently active first, with the total at the bottom.
        </li>
        <li>
          Pick a group at the top: <strong>Everyone</strong>, one of your launches, <strong>From your site</strong>, or one
          of your products. A product also shows its stages: <strong>New</strong>, <strong>Onboarding</strong>,{" "}
          <strong>Stuck</strong>, <strong>Activated</strong> and <strong>Quiet</strong>.
        </li>
        <li>
          Tick <strong>Only people we can email</strong> to leave out anyone who unsubscribed, bounced or never gave
          consent.
        </li>
        <li>Or search everyone by name, email or domain.</li>
      </Steps>
      <P>
        The same email address is the same person, so someone who joined your waitlist and then signed up to your product
        is one row. Someone who only gave a phone number is a person of their own. A sign-up from your own site joins the
        list once they confirm their email.
      </P>

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
      </UL>

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
        ]}
      />

      <NextPage slug="your-audience" />
    </article>
  );
}
