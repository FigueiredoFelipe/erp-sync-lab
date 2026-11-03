import type { ReactNode } from "react";
import { Nav } from "./_components/nav.tsx";
import "./globals.css";

export const metadata = {
  title: "ERP Revenue Sync — Harvest Table Foods (fictional)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
