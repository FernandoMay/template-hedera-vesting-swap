/**
 * Display helpers.
 *
 * Every amount that reaches the screen passes through here so units are stated exactly once.
 * The distinction that matters on Hedera: an HTS token has its own `decimals` (eight for both
 * SAUCE and WHBAR), while HBAR is always denominated in tinybars, which is HBAR times 10^10.
 */

/** Tinybars in one HBAR. */
export const TINYBAR_SCALE = 10n ** 10n;

/** Formats a raw HTS amount with `decimals` fractional digits and thousands separators. */
export function formatTokenAmount(
  amount: bigint,
  decimals: number,
  maximumFractionDigits = 4,
): string {
  const negative = amount < 0n;
  const value = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);

  const whole = value / base;
  const fraction = value % base;

  const wholeText = groupDigits(whole.toString());
  let text = wholeText;
  if (maximumFractionDigits > 0) {
    const fractionText = fraction
      .toString()
      .padStart(decimals, "0")
      .slice(0, maximumFractionDigits)
      .replace(/0+$/, "");
    if (fractionText.length > 0) text += `.${fractionText}`;
  }
  return negative ? `-${text}` : text;
}

/** Formats a tinybar amount as HBAR. */
export function formatHbar(tinybars: bigint, maximumFractionDigits = 6): string {
  return formatTokenAmount(tinybars, 10, maximumFractionDigits);
}

function groupDigits(text: string): string {
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Formats a consensus second as a short UTC timestamp. */
export function formatTimestamp(second: number): string {
  if (second <= 0) return "—";
  return new Date(second * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/**
 * Renders a duration in whole days or hours, whichever reads better.
 *
 * @param seconds Duration in seconds. Negative input is treated as zero.
 */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "complete";
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) {
    const hours = Math.floor((seconds % 86_400) / 3_600);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) {
    const minutes = Math.floor((seconds % 3_600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const minutes = Math.floor(seconds / 60);
  return minutes >= 1 ? `${minutes}m` : `${seconds}s`;
}

/**
 * Renders a `0.0.<num>` account or contract ID as a shortened label.
 *
 * Keeps both ends so an operator can still recognise the ID in a list of streams.
 */
export function shortenEntityId(entityId: string): string {
  return entityId.length > 10 ? `${entityId.slice(0, 5)}…${entityId.slice(-4)}` : entityId;
}