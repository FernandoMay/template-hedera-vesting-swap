import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Streamed vesting · HBAR payouts",
  description:
    "On-chain vesting that unlocks itself and settles every claim in HBAR through SaucerSwap V2.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}