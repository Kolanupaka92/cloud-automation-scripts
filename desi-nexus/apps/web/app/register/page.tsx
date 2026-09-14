import type { Metadata } from "next";
import Link from "next/link";
import { taxonomy } from "@/lib/api";
import { registerAction } from "@/lib/actions";
import { ActionForm } from "@/components/Form";
import { CheckGroup } from "@/components/Checks";

export const metadata: Metadata = { title: "Create an account" };

const ROLES = [
  { value: "host", title: "I am booking talent", body: "A family function, or a boutique or agency hiring for a shoot." },
  { value: "crew", title: "I am crew", body: "Makeup, hair, photo, video, henna, decor, music, catering, priest." },
  { value: "creator", title: "I am a creator", body: "Model or influencer available for campaigns and lookbooks." },
];

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  const { role } = await searchParams;
  const preselected = ROLES.some((option) => option.value === role) ? role : "host";
  const data = await taxonomy().catch(() => null);

  return (
    <div style={{ maxWidth: 620, margin: "48px auto" }}>
      <h1>Create your account</h1>
      <p className="muted">
        One account covers every side of the market. A boutique owner who also models is one
        person, not three logins.
      </p>

      <div className="card">
        <ActionForm action={registerAction} submitLabel="Create account">
          <div className="field">
            <label>What brings you here?</label>
            <div className="stack" style={{ marginTop: 8 }}>
              {ROLES.map((option) => (
                <label
                  key={option.value}
                  className="row"
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: "var(--radius)",
                    padding: "11px 13px",
                    gap: 11,
                    alignItems: "flex-start",
                    cursor: "pointer",
                    fontWeight: 400,
                  }}
                >
                  <input
                    type="checkbox"
                    name="roles"
                    value={option.value}
                    defaultChecked={option.value === preselected}
                    style={{ width: "auto", marginTop: 4, accentColor: "var(--maroon)" }}
                  />
                  <span>
                    <strong style={{ display: "block" }}>{option.title}</strong>
                    <span className="faint">{option.body}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="displayName">Name or business name</label>
            <input id="displayName" name="displayName" required minLength={2} />
          </div>

          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>

          <div className="field">
            <label htmlFor="phone">Mobile number</label>
            <input id="phone" name="phone" type="tel" placeholder="+14695550123" pattern="\+1[0-9]{10}" />
            <p className="hint">
              US mobile in +1XXXXXXXXXX form. We text a code before any booking money moves.
            </p>
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
            />
            <p className="hint">At least 12 characters. A phrase you will remember beats a puzzle you will not.</p>
          </div>

          <div className="field">
            <label htmlFor="metro">Where are you based?</label>
            <select id="metro" name="metro" required defaultValue="">
              <option value="" disabled>
                Choose your metro
              </option>
              {(data?.metros ?? []).map((metro) => (
                <option key={metro.id} value={`${metro.center.lat},${metro.center.lng}`}>
                  {metro.name}
                </option>
              ))}
            </select>
            <p className="hint">Texas only during the pilot. This sets your travel radius.</p>
          </div>

          {data && (
            <div className="field">
              <label>Languages you work in</label>
              <CheckGroup
                name="languages"
                options={data.languages}
                defaultSelected={["english"]}
              />
            </div>
          )}
        </ActionForm>
      </div>

      <p className="faint" style={{ marginTop: 14 }}>
        Already have an account? <Link href="/login">Sign in</Link>.
      </p>
    </div>
  );
}
