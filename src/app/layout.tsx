import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "vizzybl-marketing",
  description: "Multi-tenant sales & marketing platform — Waitlist MVP",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
