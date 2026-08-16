// Date parsing shared by the worker's filtering logic and the portal's
// confirmation matching. Every parser here extracts year/month/day explicitly
// before constructing a Date so that day-level comparisons never drift across
// the UTC/local boundary the way `new Date(string)` does.

function toLocalMidnight(year, month, day) {
  return new Date(year, month, day, 0, 0, 0, 0);
}

/**
 * Parse ISO (2026-09-01), MM/DD/YYYY, and text dates ("Monday, March 2",
 * "Sep 01, 2026") to local midnight. Returns null if unparseable.
 *
 * When the string carries no year — the control app sends currentScheduledDate
 * as "Wednesday, August 26" — the year is inferred as the one placing the date
 * NEAREST today, not simply the current year. Assuming the current year breaks
 * across the New Year: in late December a January inspection would resolve 12
 * months into the past and be skipped as past-due, and in early January a
 * December one would resolve 12 months into the future and look reschedulable.
 *
 * The assumption is that an undated inspection is within ~6 months of today,
 * which holds for scheduling that runs weeks out.
 */
function parseFlexibleDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (!s) return null;

  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return toLocalMidnight(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));

  const mdyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    const fullYear = y.length === 2 ? 2000 + parseInt(y, 10) : parseInt(y, 10);
    return toLocalMidnight(fullYear, parseInt(m, 10) - 1, parseInt(d, 10));
  }

  // An explicit 4-digit year in the text is authoritative — the portal's
  // confirmation table reads "Jan 08, 2027". Anything below 2020 is treated as
  // a parser artifact (bare "August 26" yields 2001 in V8) and re-inferred.
  if (/\b\d{4}\b/.test(s)) {
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime()) && parsed.getFullYear() >= 2020) {
      return toLocalMidnight(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    }
  }

  const now = new Date();
  const today = toLocalMidnight(now.getFullYear(), now.getMonth(), now.getDate());
  let best = null;
  for (const year of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
    let parsed = new Date(`${s}, ${year}`);
    if (isNaN(parsed.getTime())) parsed = new Date(`${s} ${year}`);
    if (isNaN(parsed.getTime())) continue;
    const candidate = toLocalMidnight(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    const distance = Math.abs(candidate.getTime() - today.getTime());
    if (!best || distance < best.distance) best = { date: candidate, distance };
  }
  return best ? best.date : null;
}

module.exports = { toLocalMidnight, parseFlexibleDate };
