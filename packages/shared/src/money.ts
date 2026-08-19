/**
 * Money helpers.
 *
 * Amounts are Philippine peso values kept as plain numbers. To avoid binary
 * floating-point drift (e.g. 0.1 + 0.2), rounding is done in integer centavos.
 */

/** Round a peso amount to 2 decimal places (nearest centavo, half-up). */
export function roundPeso(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/** Convert pesos to whole centavos. */
export function toCentavos(peso: number): number {
  return Math.round(peso * 100);
}

/** Convert whole centavos back to pesos. */
export function fromCentavos(centavos: number): number {
  return centavos / 100;
}
