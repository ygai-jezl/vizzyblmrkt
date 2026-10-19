import type { Metadata } from "next";
import "./globals.css";
import { GoogleAnalytics } from "@/components/marketing/GoogleAnalytics";
import { siteMetadataBase } from "@/lib/site/flags";
import { DEFAULT_DESCRIPTION } from "@/lib/site/metadata";

// Defaults for any page that sets none. metadataBase makes every relative share URL absolute on the
// canonical origin (NEXT_PUBLIC_SITE_ORIGIN or the platform origin); with neither set, Next's default applies.
export const metadata: Metadata = {
  metadataBase: siteMetadataBase(),
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
