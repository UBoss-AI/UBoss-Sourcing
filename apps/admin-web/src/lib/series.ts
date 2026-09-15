/**
 * Chart data preparation.
 *
 * Separate from the chart components so that file only exports components -
 * a module that mixes the two breaks Vite Fast Refresh, which is why this is
 * here rather than beside the sparkline that consumes it.
 */
// ---------------------------------------------------------------------------
// Series preparation
// ---------------------------------------------------------------------------

/**
 * Turn the server's sparse buckets into one value per day.
 *
 * `salesByPeriod` groups existing orders, so it returns only the days that had
 * any — eight rows for a thirty-day window is normal. Plotted straight, those
 * eight would be spread evenly across the card and the line would describe a
 * month that never happened. A day with no orders is a zero, and it has to
 * occupy its own share of the width.
 *
 * Both ends come from the window rather than from the data, so two tiles over
 * the same period always have the same number of points and the same x scale.
 */
export function fillDailySeries(
  buckets: { period: string; value: number }[],
  from: Date,
  to: Date,
): number[] {
  const byDay = new Map(buckets.map((bucket) => [bucket.period, bucket.value]));

  const out: number[] = [];
  // Walk in UTC. `period` is a `DATE_FORMAT(..., '%Y-%m-%d')` string, so
  // stepping in local time would skip or repeat a day either side of a DST
  // change and silently drop a bucket.
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());

  // A hard stop as well as the date test: a bad window must not spin here.
  for (let guard = 0; cursor.getTime() <= end && guard < 400; guard += 1) {
    const key = cursor.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? 0);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return out;
}
