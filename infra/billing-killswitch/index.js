/**
 * Billing kill-switch (Cloud Functions Gen2, CloudEvent-triggered).
 *
 * A budget publishes threshold notifications to the `billing-killswitch`
 * Pub/Sub topic. When actual cost exceeds the budget's hard cap, this function
 * DISABLES billing on its own project (unlinks the billing account), stopping
 * all billable services. This is a last-resort spend cap — budget *alerts*
 * never stop spending. See docs/SETUP.md §6 and
 * https://cloud.google.com/billing/docs/how-to/disable-billing-with-notifications
 *
 * IAM: the runtime SA needs roles/billing.projectManager on THIS project only
 * (resourcemanager.projects.deleteBillingAssignment) — not Billing Admin on the
 * whole billing account. So it can never disable a sibling project's billing.
 *
 * Note: Google's Node sample uses a Gen1 background-function signature
 * (`pubsubEvent.data`). Under Gen2 the payload is a CloudEvent and the budget
 * JSON lives at `event.data.message.data` (base64) — handled below.
 */
const functions = require("@google-cloud/functions-framework");
const { CloudBillingClient } = require("@google-cloud/billing");

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
const PROJECT_NAME = `projects/${PROJECT_ID}`;
const billing = new CloudBillingClient();

functions.cloudEvent("stopBilling", async (cloudEvent) => {
  const message = cloudEvent && cloudEvent.data && cloudEvent.data.message;
  if (!message || !message.data) {
    console.log("No Pub/Sub message data on the event; ignoring.");
    return;
  }

  const budget = JSON.parse(Buffer.from(message.data, "base64").toString());
  const { costAmount, budgetAmount } = budget;
  console.log(`budget notification: cost=${costAmount} cap=${budgetAmount}`);

  if (!(costAmount > budgetAmount)) {
    console.log(`Within cap — no action (cost ${costAmount} <= cap ${budgetAmount}).`);
    return;
  }

  if (!PROJECT_ID) {
    console.error("GOOGLE_CLOUD_PROJECT not set — cannot disable billing.");
    return;
  }

  if (await isBillingEnabled(PROJECT_NAME)) {
    const res = await disableBilling(PROJECT_NAME);
    // Logged at error severity so it shows up loudly in alerting.
    console.error(`KILL-SWITCH FIRED — billing disabled for ${PROJECT_NAME}: ${res}`);
  } else {
    console.log("Billing already disabled — nothing to do.");
  }
});

async function isBillingEnabled(projectName) {
  try {
    const [info] = await billing.getProjectBillingInfo({ name: projectName });
    return info.billingEnabled;
  } catch (e) {
    console.log(`Could not read billing info (${e.message}); assuming enabled.`);
    return true;
  }
}

async function disableBilling(projectName) {
  const [res] = await billing.updateProjectBillingInfo({
    name: projectName,
    resource: { billingAccountName: "" }, // empty string disables billing
  });
  return JSON.stringify(res);
}
