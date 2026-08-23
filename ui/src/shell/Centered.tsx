/**
 * The frame every page-replacing state in this app is drawn in.
 *
 * Lifted verbatim out of `ui/src/map/App.tsx`, where it was private. The map's
 * empty states are the house style and they are worth spreading: a state line,
 * a mono detail line, and the exact command that fixes it. The rule the four
 * new views inherit along with the box is that a view with nothing to say
 * returns null rather than drawing an empty frame — a titled panel with no rows
 * under it is a claim that there is nothing to report, which is a different
 * claim from "this was not asked".
 */
import type { ReactNode } from 'react'

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="max-w-md text-center">{children}</div>
    </div>
  )
}
