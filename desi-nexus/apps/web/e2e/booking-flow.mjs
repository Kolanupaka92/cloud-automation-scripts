/**
 * Drives the real web app in a real browser through the whole booking loop:
 * a host registers, verifies their phone, posts and publishes a gig; a vendor
 * registers, builds a profile, finds that gig in their feed and applies; the
 * host sees the applicant with a match score and books them.
 *
 * Every hop goes through the actual forms and server actions against the actual
 * API and a real PostgreSQL, because that is the only way to know the pieces
 * fit together rather than merely compile.
 */
import { chromium } from "playwright";

const WEB = process.env.WEB_URL ?? "http://127.0.0.1:3000";
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PASSWORD = "a-long-enough-passphrase";

const stamp = Date.now();
const HOST_EMAIL = `host.${stamp}@frisco.test`;
const VENDOR_EMAIL = `mua.${stamp}@plano.test`;

let failures = 0;
function check(condition, description) {
  console.log(`${condition ? "  ok  " : "FAIL  "}${description}`);
  if (!condition) failures += 1;
}

async function register(page, { email, roles, phone, metro }) {
  await page.goto(`${WEB}/register`, { waitUntil: "networkidle" });
  // Roles are checkboxes; clear the default then pick ours.
  for (const role of ["host", "crew", "creator"]) {
    const box = page.locator(`input[name="roles"][value="${role}"]`);
    if ((await box.count()) === 0) continue;
    const shouldBe = roles.includes(role);
    if ((await box.isChecked()) !== shouldBe) await box.click();
  }
  await page.fill('input[name="displayName"]', email.split("@")[0]);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="phone"]', phone);
  await page.fill('input[name="password"]', PASSWORD);
  await page.selectOption('select[name="metro"]', { label: metro });
  await page.click('main button[type="submit"]');
  await page.waitForURL("**/dashboard**", { timeout: 30_000 });
}

/** Verifying the phone is what promotes the session to MFA-verified. */
async function verifyPhone(page) {
  await page.click('.notice.info button:has-text("Send code")');
  await page.waitForSelector('input[name="code"]', { timeout: 20_000 });
  const notice = await page.textContent(".notice.info");
  const code = notice?.match(/Development code:\s*(\d{6})/)?.[1];
  if (!code) throw new Error(`no development code surfaced: ${notice}`);
  await page.fill('input[name="code"]', code);
  // Scoped to the verify prompt itself, not just to main.
  await page.click('.notice.info button[type="submit"]');
  await page.waitForURL("**/dashboard?verified=1", { timeout: 30_000 });
  return code;
}

const browser = await chromium.launch({ executablePath: CHROME });

try {
  // ---- Host: register, verify, post and publish a gig --------------------
  const host = await browser.newContext();
  const hostPage = await host.newPage();

  await register(hostPage, {
    email: HOST_EMAIL, roles: ["host"], phone: "+14695551001", metro: "Dallas-Fort Worth",
  });
  check(hostPage.url().includes("/dashboard"), "host registers and lands on the dashboard");

  const code = await verifyPhone(hostPage);
  check(/^\d{6}$/.test(code), "host verifies their phone with a one-time code");

  await hostPage.goto(`${WEB}/gigs/new`, { waitUntil: "networkidle" });
  await hostPage.selectOption('select[name="eventType"]', "half_saree_function");
  // The speciality list should now be led by what this function customarily needs.
  const suggested = await hostPage.textContent(".hint:has-text('usually needs')").catch(() => null);
  check(
    suggested?.includes("Makeup Artist") ?? false,
    "the wizard suggests the crew a Half-Saree Function actually needs",
  );

  await hostPage.selectOption('select[name="specialty"]', "mua");
  await hostPage.fill('input[name="eventDate"]', "2027-06-20");
  await hostPage.selectOption('select[name="venue"]', { label: "Dallas-Fort Worth" });
  await hostPage.fill('input[name="budgetMin"]', "400");
  await hostPage.fill('input[name="budgetMax"]', "900");
  await hostPage.click('input[name="culturalTags"][value="telugu_traditional"]');
  await hostPage.click('input[name="languages"][value="telugu"]');
  await hostPage.fill('input[name="headcount"]', "120");
  await hostPage.fill('textarea[name="notes"]', "Morning call time, two people getting ready.");
  await hostPage.click('main button[type="submit"]');
  // Not "**/gigs/**": we are already on /gigs/new, so that matches instantly
  // and hands back "new" as the id. Wait for a real gig id.
  await hostPage.waitForURL(/\/gigs\/[0-9a-f]{8}-/, { timeout: 30_000 });

  const gigUrl = hostPage.url();
  const gigId = gigUrl.split("/gigs/")[1].split("?")[0];
  check(Boolean(gigId), `gig created (${gigId.slice(0, 8)}…)`);
  check(
    (await hostPage.textContent("body"))?.includes("Draft") ?? false,
    "a new gig starts as a draft, not live",
  );

  await hostPage.click("text=Publish and start matching");
  await hostPage.waitForSelector("text=Live and matching", { timeout: 30_000 });
  // Reload too: the banner proves the action ran, the reload proves it stuck.
  await hostPage.reload({ waitUntil: "networkidle" });
  check(
    (await hostPage.textContent("main"))?.includes("Open for applications") ?? false,
    "publishing moves the gig to Open, and it is still Open after a reload",
  );

  // ---- Vendor: register, build a profile, find the gig, apply ------------
  const vendor = await browser.newContext();
  const vendorPage = await vendor.newPage();

  await register(vendorPage, {
    email: VENDOR_EMAIL, roles: ["crew"], phone: "+14695551002", metro: "Dallas-Fort Worth",
  });
  check(vendorPage.url().includes("/dashboard"), "vendor registers");

  await vendorPage.goto(`${WEB}/gigs`, { waitUntil: "networkidle" });
  check(
    (await vendorPage.textContent("body"))?.includes("vendor profile first") ?? false,
    "a vendor with no profile is told to build one rather than shown an empty feed",
  );

  await vendorPage.goto(`${WEB}/vendor`, { waitUntil: "networkidle" });
  await vendorPage.click('input[name="specialties"][value="mua"]');
  await vendorPage.click('input[name="culturalTags"][value="telugu_traditional"]');
  await vendorPage.fill('input[name="startingRate"]', "550");
  await vendorPage.fill('input[name="yearsExperience"]', "6");
  await vendorPage.click('main button[type="submit"]');
  await vendorPage.waitForSelector(".notice", { timeout: 30_000 });
  const profileNotice = (await vendorPage.textContent(".notice")) ?? "";
  check(
    (await vendorPage.locator(".notice.error").count()) === 0,
    `vendor saves a profile with specialities and cultural tags${
      profileNotice ? ` — ${profileNotice.trim().slice(0, 120)}` : ""
    }`,
  );

  await vendorPage.goto(`${WEB}/gigs`, { waitUntil: "networkidle" });
  const feed = (await vendorPage.textContent("body")) ?? "";
  check(feed.includes("Half-Saree Function"), "the host's gig appears in the vendor's feed");
  check(/Match/.test(feed), "the vendor sees their own match score for it");

  await vendorPage.click("text=Half-Saree Function");
  await vendorPage.waitForSelector('input[name="quotedRate"]', { timeout: 30_000 });
  await vendorPage.fill('input[name="quotedRate"]', "600");
  await vendorPage.fill('textarea[name="message"]', "I specialise in Telugu half-saree looks.");
  await vendorPage.click('main button[type="submit"]');
  await vendorPage.waitForSelector(".notice", { timeout: 30_000 });
  const applyNotice = (await vendorPage.textContent(".notice")) ?? "";
  check(
    (await vendorPage.locator(".notice.error").count()) === 0,
    `vendor applies to the gig${applyNotice ? ` — ${applyNotice.trim().slice(0, 120)}` : ""}`,
  );

  // ---- Host: sees the applicant with a scored breakdown, books them ------
  await hostPage.goto(`${WEB}/gigs/${gigId}`, { waitUntil: "networkidle" });
  const withApplicant = (await hostPage.textContent("body")) ?? "";
  check(withApplicant.includes("Applicants (1)"), "the host sees exactly one applicant");
  check(withApplicant.includes("$600"), "the host sees the vendor's quote");
  check(
    withApplicant.includes("Why this score"),
    "the match score is shown with its breakdown, not as a bare number",
  );

  await hostPage.click("text=Book this vendor");
  await hostPage.waitForSelector("text=Booked with this vendor", { timeout: 30_000 });
  check(true, "the host books the vendor and the gig records the accepted offer");

  await hostPage.screenshot({ path: "e2e/booked-gig.png", fullPage: true });
  console.log("\nscreenshot: e2e/booked-gig.png");
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
