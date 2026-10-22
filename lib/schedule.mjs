export function nextAutomaticDelay({ intervalHours, checkedAt, checkOnStart = true, startupDelaySeconds = 15, initial = true, now = Date.now() }) {
  if (!(intervalHours > 0)) return null;
  const interval = Math.max(60000, intervalHours * 3600000);
  const last = Date.parse(checkedAt || '');
  if (Number.isFinite(last) && last <= now) {
    const remaining = last + interval - now;
    if (remaining > 0) return remaining;
  }
  if (initial && !checkOnStart) return interval;
  return initial ? startupDelaySeconds * 1000 : 0;
}
