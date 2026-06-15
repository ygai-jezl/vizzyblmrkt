"use client";

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  GoogleAuthProvider,
  type Auth,
} from "firebase/auth";

/**
 * Browser-side Firebase Auth. The web config values are public (not secrets) and
 * are wired in at BUILD time via apphosting.yaml (NEXT_PUBLIC_*). A missing
 * apiKey fails LOUD (initializeApp throws) rather than silently shipping a
 * placeholder — except against the Auth emulator, where any value works.
 */
const useEmulator = !!process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;

const config = {
  apiKey:
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY ??
    (useEmulator ? "emulator" : undefined),
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
};

let app: FirebaseApp | undefined;
let emulatorConnected = false;

export function getClientAuth(): Auth {
  app ??= getApps()[0] ?? initializeApp(config);
  const auth = getAuth(app);
  if (useEmulator && !emulatorConnected) {
    connectAuthEmulator(
      auth,
      `http://${process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST}`,
      { disableWarnings: true },
    );
    emulatorConnected = true;
  }
  return auth;
}

/** Google provider, hinted to the org's Workspace domain. */
export function googleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  const hd = process.env.NEXT_PUBLIC_ADMIN_HD;
  provider.setCustomParameters({ prompt: "select_account", ...(hd ? { hd } : {}) });
  return provider;
}
