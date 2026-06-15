import { seedDemoData } from "@/lib/dev/seedDemo";

/**
 * Direct seed against whatever Firestore GOOGLE_CLOUD_PROJECT (+ ADC) points at.
 * Usage: GOOGLE_CLOUD_PROJECT=vizzybl-marketing-dev npm run seed
 * Refuses to touch a *-prod project. Uses Application Default Credentials
 * (`gcloud auth application-default login`).
 */
async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT (e.g. vizzybl-marketing-dev).");
    process.exit(1);
  }
  if (project.endsWith("-prod") && process.env.ALLOW_PROD_SEED !== "true") {
    console.error(
      `Refusing to seed a prod project: ${project}. Set ALLOW_PROD_SEED=true to override.`,
    );
    process.exit(1);
  }
  const target = process.env.FIRESTORE_EMULATOR_HOST
    ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}`
    : `cloud project ${project}`;
  console.log(`Seeding ${target}…`);
  const result = await seedDemoData();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
