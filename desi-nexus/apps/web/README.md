# DESI-NEXUS Web

The host and vendor web app. Next.js 15 (App Router) on React 19, talking to the
DESI-NEXUS API over HTTP.

```bash
npm install
API_URL=http://127.0.0.1:8080 npm run dev     # :3000
npm run build && npm start
```

## Why the API calls all happen on the server

Access tokens live in httpOnly cookies and are attached to API calls inside
server components and server actions. The browser never holds a token, so an XSS
on any page cannot walk off with a session that is able to move money. That is
also why there is no client-side data-fetching layer here at all.

## Layout

```
app/
  page.tsx            public landing page, cached — the SEO surface
  register, login     account creation and sign-in
  dashboard/          host's gigs, and the phone-verification prompt
  gigs/new/           the post-a-gig wizard
  gigs/[id]/          one gig: the brief, applicants, booking
  gigs/               a vendor's ranked feed of gigs they can take
  vendor/             the vendor's own profile
lib/
  api.ts              typed client; every call is server-side
  actions.ts          server actions — the only things that mutate
  session.ts          httpOnly cookie handling
  format.ts           money, dates and the snake_case → human labels
components/           form plumbing, the capped multi-select, the score bar
e2e/                  a real browser driven through the whole booking loop
```

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `API_URL` | yes | Base URL of the DESI-NEXUS API (default `http://127.0.0.1:8080`) |

## The end-to-end check

`e2e/booking-flow.mjs` drives Chromium through the entire loop against a real
API and a real PostgreSQL: a host registers, verifies their phone, posts and
publishes a gig; a vendor registers, builds a profile, finds that gig in their
feed and applies; the host sees the applicant with a scored breakdown and books
them. It asserts on the rendered page, not on mocks.

```bash
# with the API on :8080 and this app on :3000
node e2e/booking-flow.mjs
```

Writing it found four defects that neither a type-check nor a unit test can
see — see the repository README.
