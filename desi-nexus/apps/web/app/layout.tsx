import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { ACCESS_COOKIE } from "@/lib/api";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "DESI-NEXUS — South Asian event talent in Texas",
    template: "%s · DESI-NEXUS",
  },
  description:
    "Book verified makeup artists, photographers, henna artists, pandits and creators for South Asian events across Dallas-Fort Worth, Houston, Austin and San Antonio.",
  openGraph: {
    title: "DESI-NEXUS — South Asian event talent in Texas",
    description:
      "Verified crew and creators for Sangeets, Half-Saree Functions, Griha Pravesham, boutique shoots and more.",
    type: "website",
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const signedIn = Boolean((await cookies()).get(ACCESS_COOKIE)?.value);

  return (
    <html lang="en">
      <body>
        <header className="masthead">
          <div className="shell">
            <Link href="/" className="wordmark">
              DESI<span>·</span>NEXUS
            </Link>
            <nav>
              <Link href="/gigs">Browse gigs</Link>
              {signedIn ? (
                <>
                  <Link href="/dashboard">Dashboard</Link>
                  <Link href="/gigs/new" className="btn small accent">
                    Post a gig
                  </Link>
                  <form action="/api/session/logout" method="post">
                    <button type="submit" className="btn small secondary">
                      Sign out
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <Link href="/login">Sign in</Link>
                  <Link href="/register" className="btn small accent">
                    Join
                  </Link>
                </>
              )}
            </nav>
          </div>
        </header>

        <main className="shell">{children}</main>

        <footer className="foot">
          <div className="shell">
            <p>
              DESI-NEXUS — serving Dallas-Fort Worth, Greater Houston, Austin, San Antonio,
              the Rio Grande Valley, El Paso, Corpus Christi and Lubbock.
            </p>
            <p className="faint">
              Payments are held in escrow and released after the event. Pilot region: Texas.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
