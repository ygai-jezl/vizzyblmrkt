"use client";

import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { LogOut } from "lucide-react";
import { getClientAuth } from "@/lib/auth/firebaseClient";

export function LogoutButton({ variant = "link" }: { variant?: "link" | "icon" }) {
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

  if (variant === "icon") {
    return (
      <button
        onClick={logout}
        aria-label="Sign out"
        title="Sign out"
        className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      >
        <LogOut size={16} />
      </button>
    );
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
