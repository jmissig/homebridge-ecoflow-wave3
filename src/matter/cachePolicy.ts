export const CACHED_STATE_MAX_AGE_MILLISECONDS = 15 * 60_000;

export function isRecentCachedState(
  lastConfirmedAt: number | undefined,
  now: number = Date.now(),
  maximumAgeMilliseconds: number = CACHED_STATE_MAX_AGE_MILLISECONDS,
): boolean {
  return typeof lastConfirmedAt === 'number'
    && Number.isFinite(lastConfirmedAt)
    && Math.max(0, now - lastConfirmedAt) <= maximumAgeMilliseconds;
}
