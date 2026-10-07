// The privacy policy keeps order records for at most 24 months. Uninstall and
// customer redaction delete sooner; the worker's purge enforces the ceiling,
// and ingestion never stores an order already past it.
export const ORDER_RETENTION_MONTHS = 24;

// The same moment 24 calendar months earlier, clamped to the month's last day
// so 29 February never rolls into March.
export function retentionCutoff(now = new Date()) {
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - ORDER_RETENTION_MONTHS, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(now.getUTCDate(), lastDay),
    now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds()));
}

export function isPastRetention(shopifyCreatedAt, now = new Date()) {
  return shopifyCreatedAt < retentionCutoff(now);
}
