"use client";

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, connectAuthEmulator, type Auth } from "firebase/auth";

/**
 * Browser-side Firebase Auth. The web config values are public (not secrets).
 * Locally, set NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST to point at the Auth
 * emulator (the apiKey can be any non-empty placeholder for the emulator).
 */
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "emulator",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
};

let app: FirebaseApp | undefined;
let emulatorConnected = false;

export function getClientAuth(): Auth {
  app ??= getApps()[0] ?? initializeApp(config);
  const auth = getAuth(app);
  const emulator = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
  if (emulator && !emulatorConnected) {
    connectAuthEmulator(auth, `http://${emulator}`, { disableWarnings: true });
    emulatorConnected = true;
  }
  return auth;
}
