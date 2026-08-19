/**
 * The operator's identity and contact details, in one place.
 *
 * These appear in the published privacy policy, the terms, the account-deletion
 * page, and the in-app help screens — so they are defined once here and every
 * surface reads them. Changing the support email is a one-line edit; the legal
 * pages are regenerated from these values at build time.
 */

/** Trading name shown to users and named as the operator in the policy. */
export const OPERATOR_NAME = 'ServdGo';

/**
 * Public contact address for privacy requests, support and account deletion.
 *
 * CONFIRM THIS INBOX EXISTS BEFORE PUBLISHING TO GOOGLE PLAY. Play requires a
 * working contact method in the privacy policy, and a privacy request sent here
 * has to reach someone. Deliberately a business address rather than anyone's
 * personal inbox — these pages are public and get scraped.
 */
export const SUPPORT_EMAIL = 'ngasparillo@gmail.com';

/**
 * Support hotline, or null when there isn't one yet.
 *
 * Null hides the number everywhere rather than printing one that doesn't ring —
 * a placeholder in a store listing is worse than no number at all.
 */
export const SUPPORT_PHONE: string | null = null;

/** Where the published policy documents live. */
export const CUSTOMER_SITE = 'https://servdgo.vercel.app';
export const PRIVACY_URL = `${CUSTOMER_SITE}/privacy.html`;
export const TERMS_URL = `${CUSTOMER_SITE}/terms.html`;
export const ACCOUNT_DELETION_URL = `${CUSTOMER_SITE}/account-deletion.html`;

/** Date the policy documents last changed (ISO), shown on each page. */
export const POLICY_LAST_UPDATED = '2026-08-04';

/** Android package names, as published on Google Play. */
export const ANDROID_PACKAGES = {
  customer: 'com.servdgo.customer',
  rider: 'com.servdgo.rider',
} as const;
