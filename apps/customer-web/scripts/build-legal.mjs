/**
 * Generate the published legal pages from the constants in @ebd/shared/legal.
 *
 * Google Play needs three URLs that work in a browser, without the app and
 * without JavaScript: a privacy policy, terms, and a page describing account
 * deletion. Plain files in public/ are served ahead of the SPA fallback, so a
 * reviewer (or a customer) always gets the real document.
 *
 * Run from the customer-web prebuild step; edit legal.ts, not the HTML.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPERATOR_NAME, SUPPORT_EMAIL, SUPPORT_PHONE,
  PRIVACY_URL, TERMS_URL, ACCOUNT_DELETION_URL,
  POLICY_LAST_UPDATED, ANDROID_PACKAGES, CUSTOMER_SITE,
} from '@ebd/shared';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public');

if (!SUPPORT_EMAIL) {
  console.error('\n  SUPPORT_EMAIL is empty in packages/shared/src/legal.ts.');
  console.error('  Google Play requires a working contact address in the privacy policy.\n');
  process.exit(1);
}

const contactBlock = `
  <p>
    <strong>${OPERATOR_NAME}</strong><br>
    Email: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>${
      SUPPORT_PHONE ? `<br>Phone: <a href="tel:${SUPPORT_PHONE.replace(/\s/g, '')}">${SUPPORT_PHONE}</a>` : ''
    }
  </p>`;

/** Shared page chrome: readable on a phone, no external requests, no script. */
const page = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${OPERATOR_NAME}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0 auto; padding: 2rem 1.25rem 4rem; max-width: 44rem;
    font: 16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #1a1a1a; background: #fff;
  }
  header { border-bottom: 3px solid #6DBE22; padding-bottom: .75rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
  .meta { color: #666; font-size: .875rem; margin: 0; }
  a { color: #5E2D91; }
  ul { padding-left: 1.25rem; }
  li { margin: .35rem 0; }
  table { border-collapse: collapse; width: 100%; margin: .75rem 0; font-size: .95rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  th { background: #f6f7f4; }
  .note { background: #f6f7f4; border-left: 3px solid #6DBE22; padding: .75rem 1rem; margin: 1rem 0; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e5e5e5; font-size: .875rem; color: #666; }
  @media (prefers-color-scheme: dark) {
    body { color: #ececec; background: #16181c; }
    a { color: #b79cf0; }
    th { background: #22252b; }
    th, td { border-bottom-color: #2e3239; }
    .note { background: #22252b; }
    footer { border-top-color: #2e3239; }
    .meta, footer { color: #a0a4ab; }
  }
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <p class="meta">${OPERATOR_NAME} — Pabili &amp; Padala delivery · Last updated ${POLICY_LAST_UPDATED}</p>
</header>
${body}
<footer>
  <p>
    <a href="${PRIVACY_URL}">Privacy Policy</a> ·
    <a href="${TERMS_URL}">Terms of Service</a> ·
    <a href="${ACCOUNT_DELETION_URL}">Delete your account</a> ·
    <a href="${CUSTOMER_SITE}">Open the app</a>
  </p>
</footer>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// Privacy policy
// ---------------------------------------------------------------------------
const privacy = page('Privacy Policy', `
<p>
  This policy explains what ${OPERATOR_NAME} collects when you use our customer
  app or our rider app, why we collect it, and what control you have over it.
  It covers the Android apps
  <code>${ANDROID_PACKAGES.customer}</code> and <code>${ANDROID_PACKAGES.rider}</code>
  and the website at ${CUSTOMER_SITE}.
</p>

<h2>What we collect</h2>
<table>
  <tr><th>Data</th><th>Why</th></tr>
  <tr><td>Your name and mobile number</td><td>So the rider can reach you and hand the order to the right person.</td></tr>
  <tr><td>Email address</td><td>Signing in. We use a one-time code sent to your email; we never see your Google password.</td></tr>
  <tr><td>Delivery and pickup location (map pin and written address)</td><td>To calculate the delivery fee, to route the rider, and to find your door.</td></tr>
  <tr><td>Order contents — items, notes, amounts, payment method</td><td>To buy the right things and charge the right amount.</td></tr>
  <tr><td>Messages and photos you send in the order chat</td><td>To let you and your rider sort out a delivery in progress.</td></tr>
  <tr><td>Payment reference or receipt image you upload</td><td>To confirm a GCash payment reached the rider. We never receive or store card or bank credentials.</td></tr>
</table>

<h3>Riders only</h3>
<table>
  <tr><th>Data</th><th>Why</th></tr>
  <tr><td>Location while a delivery is in progress — including in the background</td><td>So the customer can watch the delivery approach on a live map. Sharing starts when you pick an order up and stops when you deliver it. It is never collected while you are off duty or between orders.</td></tr>
  <tr><td>Vehicle details and verification documents (OR/CR, driver's licence, proof of address)</td><td>To verify riders before approving them. Visible only to the operator.</td></tr>
  <tr><td>Profile photo and payout number</td><td>Shown to the customer during a delivery; used to settle commission.</td></tr>
  <tr><td>Earnings, commission and settlement records</td><td>To operate the commission system and keep the operator's books.</td></tr>
</table>

<div class="note">
  <strong>Background location, plainly.</strong> The rider app streams a rider's
  position only between picking an order up and completing it. It does not track
  riders when they are off duty, and it is never collected in the customer app.
  A persistent notification shows while it is running.
</div>

<h2>What we do not do</h2>
<ul>
  <li>We do not sell your data, and we do not share it with advertisers or data brokers.</li>
  <li>We do not use your data for advertising or profiling.</li>
  <li>We do not collect anything from your device beyond what is listed above.</li>
</ul>

<h2>Who sees it</h2>
<ul>
  <li><strong>Your rider</strong> sees your name, number, delivery address and order contents for the delivery they are handling — and only while they are handling it.</li>
  <li><strong>The operator</strong> sees orders, riders and settlements in order to run the service and resolve disputes.</li>
  <li><strong>Our hosting provider (Supabase)</strong> stores the data on our behalf. Map tiles are served by OpenStreetMap, which receives the map view your device requests.</li>
  <li><strong>Stores</strong> may receive an SMS listing the items you ordered, so they can prepare it.</li>
  <li>We disclose data otherwise only when the law requires it.</li>
</ul>

<h2>How long we keep it</h2>
<p>
  Order records are kept for as long as we need them for accounting, tax and
  dispute handling. Chat messages and photos are kept with the order. Live
  location points are transient and used only to draw the map during an active
  delivery.
</p>

<h2>Your choices</h2>
<ul>
  <li><strong>Location:</strong> you can refuse or revoke location permission in Android settings. The customer app then needs you to place the pin manually; the rider app cannot show live tracking to your customer.</li>
  <li><strong>Notifications:</strong> can be turned off in the app's settings or in Android settings.</li>
  <li><strong>Access and correction:</strong> your profile and addresses are editable in the app; write to us for anything else.</li>
  <li><strong>Deletion:</strong> see <a href="${ACCOUNT_DELETION_URL}">deleting your account</a>.</li>
</ul>

<h2>Children</h2>
<p>The service is not directed at children under 13, and we do not knowingly collect their data.</p>

<h2>Changes</h2>
<p>
  If this policy changes materially we will update the date at the top and, where
  the change affects you, tell you in the app.
</p>

<h2>Contact</h2>
<p>For any privacy question or request, including data deletion:</p>
${contactBlock}
`);

// ---------------------------------------------------------------------------
// Terms of service
// ---------------------------------------------------------------------------
const terms = page('Terms of Service', `
<p>
  By using ${OPERATOR_NAME} you agree to these terms. If you do not agree,
  please do not use the service.
</p>

<h2>What the service is</h2>
<p>
  ${OPERATOR_NAME} connects customers with independent riders for three kinds of
  errand: <strong>Food</strong> (ordering from a listed store),
  <strong>Pabili</strong> (a rider buys items on your behalf) and
  <strong>Padala</strong> (a rider carries a parcel from one place to another).
  We coordinate the delivery. We do not manufacture, prepare or sell the goods
  themselves, and we are not the merchant.
</p>

<h2>Fees and payment</h2>
<ul>
  <li>The delivery fee, any per-store fee and any convenience fee are shown before you place an order.</li>
  <li>For Pabili, you also repay the actual cost of the goods. The rider records the receipt total, which may differ from your estimate — you set a budget cap, and the rider must ask before exceeding it.</li>
  <li>Payment is cash on delivery, GCash to the rider, or online, as offered at checkout.</li>
</ul>

<h2>Cancellation</h2>
<p>
  You may cancel while an order is still pending. Once a rider has bought goods
  on your behalf, you are responsible for the cost of those goods.
</p>

<h2>Your responsibilities</h2>
<ul>
  <li>Give accurate delivery details and a reachable number.</li>
  <li>Do not ask a rider to buy or carry anything illegal, dangerous, or prohibited — including weapons, drugs, live animals, or hazardous materials.</li>
  <li>Treat riders with respect. Abuse or harassment ends the account.</li>
</ul>

<h2>Riders</h2>
<p>
  Riders are independent contractors, not employees. A rider accepts orders at
  their own discretion, is responsible for their own vehicle, licence and
  insurance, and settles the operator's commission on the terms shown in the
  rider app. Accounts with an unsettled balance are locked until it is paid.
</p>

<h2>Service availability</h2>
<p>
  We serve limited areas and rely on riders being on duty. When no rider is
  available, the app will say so and you will not be able to place an order
  until one is. We do not guarantee delivery times.
</p>

<h2>Liability</h2>
<p>
  We are responsible for coordinating the delivery. We are not liable for the
  quality, safety or legality of goods sold by a store or bought on your behalf,
  and our liability for any claim is limited to the fees you paid for the order
  concerned. Nothing here limits rights you have under Philippine consumer law.
</p>

<h2>Ending your account</h2>
<p>
  You can delete your account at any time — see
  <a href="${ACCOUNT_DELETION_URL}">deleting your account</a>. We may suspend an
  account that breaches these terms.
</p>

<h2>Governing law</h2>
<p>These terms are governed by the laws of the Republic of the Philippines.</p>

<h2>Contact</h2>
${contactBlock}
`);

// ---------------------------------------------------------------------------
// Account deletion (required by Google Play as a public URL)
// ---------------------------------------------------------------------------
const deletion = page('Delete your account', `
<p>
  You can delete your ${OPERATOR_NAME} account and its personal data at any
  time. This page explains how, and exactly what is removed — it applies to both
  the customer app (<code>${ANDROID_PACKAGES.customer}</code>) and the rider app
  (<code>${ANDROID_PACKAGES.rider}</code>).
</p>

<h2>From inside the app</h2>
<ol>
  <li><strong>Customer app:</strong> open <em>Account</em>, scroll to <em>Delete account</em>, and confirm.</li>
  <li><strong>Rider app:</strong> open <em>Settings</em>, scroll to <em>Delete account</em>, and confirm.</li>
</ol>
<p>Deletion is immediate. You are signed out and the login stops working.</p>

<h2>By email</h2>
<p>
  If you can no longer sign in, write to us from the email address on the
  account and we will delete it for you, normally within 7 days:
</p>
${contactBlock}

<h2>What is deleted</h2>
<ul>
  <li>Your login, so the account can no longer be used.</li>
  <li>Your name, mobile number and email.</li>
  <li>Your saved delivery addresses.</li>
  <li>Riders: profile photo, payout number, vehicle details and verification documents.</li>
  <li>Notification tokens and any stored location points.</li>
</ul>

<h2>What is kept, and why</h2>
<p>
  Records of completed orders are kept for accounting, tax and dispute handling,
  and because a delivery involves other people whose records are not yours to
  erase. They are kept <strong>stripped of everything that identifies you</strong>
  — no name, number, address, map pin or notes remain. What is left is a fee, a
  service type and a date, tied to nobody.
</p>
<p>
  For riders, commission and settlement records remain in the operator's books
  for the same reason, no longer linked to a person.
</p>

<h2>When deletion has to wait</h2>
<ul>
  <li><strong>A delivery is in progress.</strong> Wait for it to complete or cancel it first — someone is on the other end of it.</li>
  <li><strong>A rider still owes commission.</strong> Settle the balance first.</li>
</ul>
<p>The app tells you which of these applies and what to do.</p>
`);

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/privacy.html`, privacy);
writeFileSync(`${OUT}/terms.html`, terms);
writeFileSync(`${OUT}/account-deletion.html`, deletion);
console.log(`legal pages written to ${OUT} (contact: ${SUPPORT_EMAIL})`);
