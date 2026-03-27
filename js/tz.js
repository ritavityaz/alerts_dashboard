/**
 * Israel timezone utilities — DST-correct for any timestamp.
 *
 * All functions accept UTC epoch ms and return Israel wall-clock values.
 * Uses pre-allocated Intl.DateTimeFormat for performance (~sub-µs per call).
 */

const TZ = "Asia/Jerusalem";

const _partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hour12: false,
});

/**
 * Return Israel wall-clock parts for a UTC epoch ms.
 * @param {number} utcMs
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
export function israelParts(utcMs) {
  const p = {};
  for (const { type, value } of _partsFmt.formatToParts(new Date(utcMs))) {
    if (type !== "literal") p[type] = +value;
  }
  if (p.hour === 24) p.hour = 0;
  return p;
}

/**
 * Return the UTC epoch ms of Israel midnight for the day containing utcMs.
 * E.g. for 2026-03-26T22:30Z (Israel 01:30 IDT on Mar 27) → returns UTC ms
 * of 2026-03-26T21:00Z (Israel midnight Mar 27, UTC+3).
 * @param {number} utcMs
 * @returns {number}
 */
export function israelDayStartUtc(utcMs) {
  const { year, month, day } = israelParts(utcMs);
  // Build midnight in Israel as if UTC, then find the real UTC offset at that midnight
  const midnightFakeUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  // Find the Israel offset at that midnight
  const mp = israelParts(midnightFakeUtc);
  // mp tells us what Israel wall-clock time corresponds to midnightFakeUtc.
  // The offset is: midnightFakeUtc showed as mp.hour:mp.minute in Israel,
  // so Israel midnight = midnightFakeUtc - (mp.hour * 3600000 + mp.minute * 60000)
  // But we need to be careful: if the date rolled, we need to adjust.
  // Simpler approach: we know the Israel date (year, month, day).
  // Israel midnight UTC = Date.UTC(year, month-1, day) - israelOffsetAtMidnight.
  // israelOffsetAtMidnight = israelLocalMs - utcMs at that point.
  // Use a round-trip: pick a guess UTC, see what Israel time it maps to, adjust.
  const guess = midnightFakeUtc; // This is midnight UTC, which is 2am or 3am Israel
  const gp = israelParts(guess);
  // gp.hour:gp.minute is the Israel time at `guess` UTC.
  // Offset = gp represents how far ahead Israel is.
  const offsetMs = gp.hour * 3600000 + gp.minute * 60000 + gp.second * 1000;
  // But gp might be on a different date if offset pushes past midnight
  // If gp.day === day, midnight Israel = guess - offsetMs
  // If gp.day === day+1, midnight Israel = guess - offsetMs (still correct, offset > 0 means Israel is ahead)
  let midnightUtc = guess - offsetMs;
  // Verify: israelParts(midnightUtc) should give hour=0, minute=0, same day
  const check = israelParts(midnightUtc);
  if (check.day !== day || check.hour !== 0) {
    // Edge case near DST transition — adjust by the difference
    midnightUtc -= (check.hour * 3600000 + check.minute * 60000 + check.second * 1000);
    // If hour was 23 (we overshot backward), add a day
    if (check.hour === 23) midnightUtc += 86400000;
  }
  return midnightUtc;
}

/**
 * Fractional hour of day (0–24) in Israel time.
 * @param {number} utcMs
 * @returns {number}
 */
export function israelHourOfDay(utcMs) {
  const { hour, minute, second } = israelParts(utcMs);
  return hour + minute / 60 + second / 3600;
}

const _hhmm = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Format as "HH:MM" in Israel time.
 * @param {number} utcMs
 * @returns {string}
 */
export function israelTimeHHMM(utcMs) {
  return _hhmm.format(new Date(utcMs));
}

const _dm = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  day: "numeric",
  month: "numeric",
});

/**
 * Format as "D/M" in Israel time (e.g. "29/3").
 * @param {number} utcMs
 * @returns {string}
 */
export function israelDateDM(utcMs) {
  return _dm.format(new Date(utcMs));
}

/**
 * Format as "D/M HH:MM" in Israel time.
 * @param {number} utcMs
 * @returns {string}
 */
export function israelDateTimeShort(utcMs) {
  return `${israelDateDM(utcMs)} ${israelTimeHHMM(utcMs)}`;
}

/**
 * Step from one Israel-day midnight to the next, DST-safe.
 * Adds 25 hours then snaps to Israel midnight to handle 23h/25h DST days.
 * @param {number} dayStartUtcMs — must be an Israel midnight (from israelDayStartUtc)
 * @returns {number} next Israel midnight as UTC ms
 */
export function nextIsraelDay(dayStartUtcMs) {
  return israelDayStartUtc(dayStartUtcMs + 25 * 3600000);
}
