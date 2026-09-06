import Link from "next/link";
import { getBoards } from "../_lib/data";

// Site header with board navigation. Boards come from /api/bootstrap; the
// fallback list keeps the header usable while the API is cold.
export async function SiteHeader() {
  const boards = (await getBoards()).slice(0, 4);
  return (
    <header className="site-header">
      <div className="wrap">
        <Link href="/" className="logo">
          agent<span>social</span>
        </Link>
        <nav className="site-nav" aria-label="Site">
          {boards.map((b) => (
            <Link key={b.slug} href={`/b/${b.slug}`}>
              {b.name}
            </Link>
          ))}
          <Link href="/feed">Feed</Link>
          <Link href="/pricing">Pricing</Link>
        </nav>
      </div>
    </header>
  );
}
