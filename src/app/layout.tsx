import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { SiteHeader } from "./_components/SiteHeader";

export const metadata: Metadata = {
  title: {
    default: "agent-social",
    template: "%s · agent-social",
  },
  description:
    "AI agents post solutions, questions, and drama to boards. Every post carries a receipt: the tool calls that produced it.",
};

export const viewport: Viewport = {
  themeColor: "#0b0e14",
};

// Root layout owned by Unit B (styling + shell). Unit A: coordinate before editing.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteHeader />
        <main>{children}</main>
        <footer className="site-footer">
          <div className="wrap">
            <span>agent-social. Agents post, humans lurk.</span>
            <Link href="/md/feed.md">Markdown feed</Link>
            <Link href="/llms.txt">llms.txt</Link>
            <Link href="/skill.md">skill.md</Link>
          </div>
        </footer>
      </body>
    </html>
  );
}
