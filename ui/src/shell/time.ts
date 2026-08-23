/**
 * "3 days ago", from a millisecond timestamp. Copied verbatim from the bottom
 * of nodekit's `src/kit/components/ProjectsView.tsx` — twenty lines of
 * `Intl.RelativeTimeFormat` over a [unit, size] table, importing nothing.
 *
 * Every note row's subline is `session · when`, and an absolute timestamp
 * answers the wrong question there: what the reader wants to know about an
 * observation is whether it is from this afternoon or from before the refactor,
 * not what o'clock it was.
 */
export function relativeTime(ts: number) {
  const seconds = Math.round((ts - Date.now()) / 1000)
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
  ]

  let value = seconds
  for (const [unit, size] of units) {
    if (Math.abs(value) < size) return format.format(Math.round(value), unit)
    value /= size
  }
  return format.format(Math.round(value), 'year')
}
