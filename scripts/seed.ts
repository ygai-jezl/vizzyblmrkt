import { loadEnvConfig } from "@next/env";

/**
 * Seed the demo brand (Acme, tenant ten_demo) into Firestore, plus the demo
 * admin (admin@example.com) when the Auth emulator is running.
 *
 * `npm run local` runs this for you on every start. By hand: start the
 * emulators (`npm run emulators`) and run `npm run seed`. Reads .env.local like
 * the app does (values already in the shell win).
 *
 * Only `demo-*` projects are seeded. Those exist only in the emulators, so the
 * emulators must be running. Seeding a real project needs
 * ALLOW_REAL_PROJECT_SEED=true (and Application Default Credentials); a
 * `*-prod` project also needs ALLOW_PROD_SEED=true.
 */
function refuse(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  loadEnvConfig(process.cwd(), true, { info: () => {}, error: console.error });

  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) refuse("Set GOOGLE_CLOUD_PROJECT (npm run local writes .env.local with demo-yougrow).");
  const isDemo = project.startsWith("demo-");
  if (!isDemo && process.env.ALLOW_REAL_PROJECT_SEED !== "true") {
    refuse(`Refusing to seed ${project}: only demo-* (emulator) projects are seeded. Set ALLOW_REAL_PROJECT_SEED=true to seed a real project on purpose.`);
  }
  if (project.endsWith("-prod") && process.env.ALLOW_PROD_SEED !== "true") {
    refuse(`Refusing to seed a prod project: ${project}. Set ALLOW_PROD_SEED=true as well to override.`);
  }
  if (isDemo && !process.env.FIRESTORE_EMULATOR_HOST) {
    refuse(`${project} only exists in the emulators. Run npm run local (it seeds for you), or start npm run emulators and set FIRESTORE_EMULATOR_HOST.`);
  }

  // Imported after the env is loaded, so modules that read it see .env.local.
  const { seedDemoData } = await import("@/lib/dev/seedDemo");
  const { seedAdminUser } = await import("@/lib/dev/seedAdmin");

  const target = process.env.FIRESTORE_EMULATOR_HOST
    ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}`
    : `cloud project ${project}`;
  console.log(`Seeding ${target} (project ${project})...`);
  const result = await seedDemoData();
  // Only seed an admin auth user against the Auth emulator (never real Identity Platform).
  const admin = process.env.FIREBASE_AUTH_EMULATOR_HOST ? (await seedAdminUser()).email : null;
  console.log(JSON.stringify({ ...result, admin }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
