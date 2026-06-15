"use client";

/**
 * Browser-side reCAPTCHA Enterprise (score-based / invisible). Loads the script
 * on demand and mints a token for a given action. Returns undefined when no site
 * key is configured (the server flag should also be off in that case).
 */
interface GrecaptchaEnterprise {
  ready(cb: () => void): void;
  execute(siteKey: string, opts: { action: string }): Promise<string>;
}
declare global {
  interface Window {
    grecaptcha?: { enterprise?: GrecaptchaEnterprise };
  }
}

let scriptPromise: Promise<void> | null = null;

function loadScript(siteKey: string): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    if (window.grecaptcha?.enterprise) return resolve();
    const s = document.createElement("script");
    s.src = `https://www.google.com/recaptcha/enterprise.js?render=${siteKey}`;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("recaptcha script failed to load"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export async function getRecaptchaToken(action: string): Promise<string | undefined> {
  const siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
  if (!siteKey) return undefined;
  await loadScript(siteKey);
  const enterprise = window.grecaptcha?.enterprise;
  if (!enterprise) return undefined;
  return new Promise<string>((resolve, reject) => {
    enterprise.ready(() => {
      enterprise.execute(siteKey, { action }).then(resolve, reject);
    });
  });
}
