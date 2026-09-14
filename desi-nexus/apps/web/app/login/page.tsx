import type { Metadata } from "next";
import Link from "next/link";
import { loginAction } from "@/lib/actions";
import { ActionForm } from "@/components/Form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <div style={{ maxWidth: 420, margin: "56px auto" }}>
      <h1>Sign in</h1>
      <div className="card">
        <ActionForm action={loginAction} submitLabel="Sign in">
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
        </ActionForm>
      </div>
      <p className="faint" style={{ marginTop: 14 }}>
        New here? <Link href="/register">Create an account</Link>.
      </p>
    </div>
  );
}
