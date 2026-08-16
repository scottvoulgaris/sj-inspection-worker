// Date parsing shared by the worker's filtering logic and the portal's
// confirmation matching. Every parser here extracts year/month/day explicitly
// before constructing a Date so that day-level comparisons never drift across
// the UTC/local boundary the way `new Date(string)` does.

function toLocalMidnight(year, month, day) {
  return new Date(year, month, day, 0, 0, 0, 0);
}

/**
 * Parse ISO (2026-09-01), MM/DD/YYYY, and text dates ("Monday, March 2",
 * "Sep 01, 2026") to local midnight. Years before 2020 are treated as a
 * missing year and corrected to the current one. Returns null if unparseable.
 */
function parseFlexibleDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (!s) return null;
  const currentYear = new Date().getFullYear();

  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return toLocalMidnight(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));

  const mdyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    const fullYear = y.length === 2 ? 2000 + parseInt(y, 10) : parseInt(y, 10);
    return toLocalMidnight(fullYear, parseInt(m, 10) - 1, parseInt(d, 10));
  }

  let parsed = new Date(s);
  if (isNaN(parsed.getTime())) parsed = new Date(`${s}, ${currentYear}`);
  if (isNaN(parsed.getTime())) parsed = new Date(`${s} ${currentYear}`);
  if (isNaN(parsed.getTime())) return null;
  const yr = parsed.getFullYear() < 2020 ? currentYear : parsed.getFullYear();
  return toLocalMidnight(yr, parsed.getMonth(), parsed.getDate());
}

module.exports = { toLocalMidnight, parseFlexibleDate };
