"use client";

import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { getClientAuth } from "@/lib/auth/firebaseClient";

export function LogoutButton() {
  const router = useRouter();
  async function logout() {
    await fetch("/api/auth/session", { method: "DELETE" });
    try {
      await signOut(getClientAuth());
    } catch {
      // ignore — the server session cookie is already cleared
    }
    router.push("/login");
    router.refresh();
  }
  return (
    <button
      onClick={logout}
      className="text-sm text-neutral-500 underline underline-offset-4 hover:text-neutral-800 dark:hover:text-neutral-200"
    >
      Sign out
    </button>
  );
}
