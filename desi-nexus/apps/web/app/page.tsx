import Link from "next/link";
import { taxonomy } from "@/lib/api";
import { label } from "@/lib/format";

/**
 * The public landing page.
 *
 * Rendered on the server and cached, because this is the page that has to rank:
 * the taxonomy below is the long tail of search terms nobody else covers --
 * "Half-Saree Function makeup artist Frisco" is not a query a generic
 * marketplace has a page for.
 */
export const revalidate = 3600;

const HOW_IT_WORKS = [
  {
    title: "Post what you are actually planning",
    body: "A Sangeet is not a reception and a Griha Pravesham is not a birthday. Pick the real occasion, the look you want, and the languages you need on the day.",
  },
  {
    title: "Get matched in under an hour",
    body: "We rank local crew on cultural fit first, then distance, budget, language and track record — and show you why each one ranked where they did.",
  },
  {
    title: "Pay into escrow, not into hope",
    body: "Your deposit is held until the work is delivered. If a vendor cancels on you, the refund is automatic and total.",
  },
];

export default async function HomePage() {
  let groups: Record<string, string[]> = {};
  try {
    const data = await taxonomy();
    groups = data.eventGroups;
  } catch {
    // The landing page is the front door; it renders without the API rather
    // than 500ing at a first-time visitor.
  }

  return (
    <>
      <section style={{ padding: "56px 0 12px", maxWidth: 720 }}>
        <span className="pill">Texas pilot · now booking</span>
        <h1 style={{ marginTop: 16, fontSize: "2.6rem" }}>
          The people who actually know your function.
        </h1>
        <p style={{ fontSize: "1.1rem", color: "var(--ink-soft)" }}>
          Makeup artists, photographers, henna artists, decorators, pandits and creators for
          South Asian events across Texas. Matched on the thing that matters — whether they
          have done <em>your</em> kind of function before.
        </p>
        <div className="row" style={{ marginTop: 22 }}>
          <Link href="/register?role=host" className="btn">
            Find talent for my event
          </Link>
          <Link href="/register?role=crew" className="btn secondary">
            I am a vendor — get booked
          </Link>
        </div>
      </section>

      <section className="grid three" style={{ marginTop: 48 }}>
        {HOW_IT_WORKS.map((step, index) => (
          <div className="card" key={step.title}>
            <span className="pill plain">Step {index + 1}</span>
            <h3 style={{ marginTop: 12 }}>{step.title}</h3>
            <p className="muted" style={{ margin: 0, fontSize: "0.94rem" }}>
              {step.body}
            </p>
          </div>
        ))}
      </section>

      {Object.keys(groups).length > 0 && (
        <section style={{ marginTop: 56 }}>
          <h2>Every occasion, named properly</h2>
          <p className="muted" style={{ maxWidth: 620 }}>
            Not &ldquo;wedding&rdquo; and &ldquo;party&rdquo;. The vendors on this platform tag
            themselves by the functions they have actually worked.
          </p>
          <div className="grid two" style={{ marginTop: 18 }}>
            {Object.entries(groups).map(([group, events]) => (
              <div className="card" key={group}>
                <h3>{label(group)}</h3>
                <div className="row" style={{ gap: 7 }}>
                  {events.map((event) => (
                    <span className="pill tag" key={event}>
                      {label(event)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
