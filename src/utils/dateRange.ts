/**
 * Purpose: `from` / `to` query filters read in the organization's timezone.
 * A bare date (2026-10-01) means that local day, not the UTC day: a Bahrain store's 1am sale
 * belongs to the local date. Both ends are inclusive days, so the range is
 * [local midnight of `from`, local midnight of the day after `to`). A full date-time keeps its
 * own offset (`from` inclusive, `to` exclusive). Unparseable values are ignored, matching the
 * lenient list endpoints.
 */

const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (east positive). */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant of local midnight on the given calendar day in `timeZone`. */
export function localMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  let instant = guess - zoneOffset(guess, timeZone);
  // A second pass settles days where the offset changes (DST); GCC zones have none.
  instant = guess - zoneOffset(instant, timeZone);
  return new Date(instant);
}

function parseBound(value: string | undefined, timeZone: string, end: boolean): Date | undefined {
  const text = value?.trim();
  if (!text) return undefined;

  const bare = BARE_DATE.exec(text);
  if (bare) {
    const [year, month, day] = [Number(bare[1]), Number(bare[2]), Number(bare[3])];
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      return undefined; // e.g. 2026-02-30
    }
    return end ? localMidnight(year, month, day + 1, timeZone) : localMidnight(year, month, day, timeZone);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** A Mongo range on createdAt, or undefined when neither bound is usable. */
export function createdAtRange(
  from: string | undefined,
  to: string | undefined,
  timeZone: string
): { $gte?: Date; $lt?: Date } | undefined {
  const range: { $gte?: Date; $lt?: Date } = {};
  const start = parseBound(from, timeZone, false);
  const end = parseBound(to, timeZone, true);
  if (start) range.$gte = start;
  if (end) range.$lt = end;
  return Object.keys(range).length > 0 ? range : undefined;
}
