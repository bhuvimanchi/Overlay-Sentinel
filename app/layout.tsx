import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Overlay Sentinel — Interview Integrity",
  description: "Zero-install detection of hidden AI interview copilots",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
