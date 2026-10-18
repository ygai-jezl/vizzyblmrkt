import type { Metadata } from "next";
import "./globals.css";
import { GoogleAnalytics } from "@/components/marketing/GoogleAnalytics";
import { siteOrigin } from "@/lib/site/flags";
import { DEFAULT_DESCRIPTION } from "@/lib/site/metadata";

// Defaults for any page that sets none. metadataBase makes every relative share URL absolute on the canonical origin.
export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
  title: "YouGrow.ai",
  description: DEFAULT_DESCRIPTION,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        <GoogleAnalytics />
      </body>
    </html>
  );
}
