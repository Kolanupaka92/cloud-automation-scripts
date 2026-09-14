/**
 * Session cookies.
 *
 * The tokens live in httpOnly cookies and are attached to API calls on the
 * server. The browser never sees them, so an XSS on any page cannot walk off
 * with a session that is able to move money.
 */
import { cookies } from "next/headers";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "./api";

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

export async function storeSession(tokens: TokenPair): Promise<void> {
  const jar = await cookies();
  const secure = process.env.NODE_ENV === "production";

  jar.set(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure,
    // Lax rather than Strict: the OAuth and Stripe return trips are top-level
    // navigations back to us, and Strict would drop the session on arrival.
    sameSite: "lax",
    path: "/",
    maxAge: tokens.expiresIn,
  });
  jar.set(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}
