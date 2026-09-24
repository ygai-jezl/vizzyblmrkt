import type { Metadata } from "next";
import "./globals.css";
import { GoogleAnalytics } from "@/components/marketing/GoogleAnalytics";

export const metadata: Metadata = {
  title: "vizzybl-marketing",
  description: "Multi-tenant sales & marketing platform — Waitlist MVP",
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
