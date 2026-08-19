/**
 * Feature flags.
 *
 * REQUIRE_ACCOUNT — when true, customers must create a phone-verified account
 * (OTP) before ordering. Keep this false until an SMS provider is configured on
 * the Supabase project; while false the app is open and ordering uses a
 * background anonymous session. Flip to true (and enable an SMS provider +
 * anonymous sign-ins off) to turn the account gate on.
 */
export const REQUIRE_ACCOUNT = true;

/** Operator hotline shown in the customer Account → Help section. */
// Support contact lives in @ebd/shared/legal — one source for both apps and
// the published policy pages.

/** App version shown in Account → About. */
export const APP_VERSION = '1.0.0';
