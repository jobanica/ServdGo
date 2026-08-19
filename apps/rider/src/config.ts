/**
 * Feature flags.
 *
 * REQUIRE_ACCOUNT — when true, riders must sign in with phone OTP. Keep this
 * false until an SMS provider is configured; while false the OTP screen is
 * hidden and a background anonymous session is used so riders can still apply
 * and (once approved) take orders. Flip to true to enable OTP sign-in.
 */
export const REQUIRE_ACCOUNT = false;

/**
 * REQUIRE_DOCUMENTS — when true, riders must upload their OR/CR, driver's
 * license, and proof of address before entering the app. Hidden for now; the
 * upload UI and storage/columns stay in place. Flip to true to re-enable
 * (also re-apply the document gate in set_rider_online / orders_rider_claim).
 */
export const REQUIRE_DOCUMENTS = false;

/** App version shown in Settings → About. */
export const APP_VERSION = '1.0.0';

// Support contact and the published policy URLs live in @ebd/shared/legal, so
// both apps and the legal pages themselves can never drift apart.
