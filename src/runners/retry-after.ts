/**
 * Parse an HTTP `Retry-After` header into milliseconds. Accepts delay
 * seconds (`120`) or an HTTP date; anything else (absent, negative,
 * unparseable, a date in the past) means no usable hint. Shared by the
 * runners that speak raw HTTP; the Anthropic SDK retries inside its own
 * calls as well, so this only sharpens the scheduler-level outer retry.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  // A finite number is definitive — including a negative one, which means
  // "no usable hint", not "a date". Falling through to Date.parse would
  // turn '-5' into an ancient date and report a zero wait instead.
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : undefined;

  const at = Date.parse(trimmed);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return undefined;
}
