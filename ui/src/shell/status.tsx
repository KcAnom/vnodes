/**
 * One poll of the daemon, shared by everything that needs it.
 *
 * The rail's health dot and the overview's counts are the same fact, and two
 * components polling `/status` on two timers would be two facts that can
 * disagree for a few seconds at a time. So the poll lives once, here.
 *
 * `/ui/api/health` is fetched exactly once, on mount: doctor's checks, the log
 * tails and the effective config do not change on a timer, and a page that
 * re-ran doctor every ten seconds would be doing real work — port probes, a
 * manifest read — to redraw seven lines that almost never move. The one thing
 * that call *does* feed back into the loop is `ui.sidebar_refresh_s`, which is
 * how often `/status` is asked. That key has been in the config since the first
 * milestone with nothing reading it; this is the reader.
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchHealth, fetchStatus } from './api'
import type { Health, Status } from './api'

/** What the config ships as, and what is used when the health call is refused. */
const DEFAULT_REFRESH_S = 10

export type Feed = {
  status: Status | null
  statusError: string
  health: Health | null
  healthError: string
  refreshMs: number
}

const FeedContext = createContext<Feed>({
  status: null,
  statusError: '',
  health: null,
  healthError: '',
  refreshMs: DEFAULT_REFRESH_S * 1000,
})

export function StatusFeed({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState('')
  const [status, setStatus] = useState<Status | null>(null)
  const [statusError, setStatusError] = useState('')

  useEffect(() => {
    let live = true
    fetchHealth()
      .then((next) => live && setHealth(next))
      .catch((cause: Error) => live && setHealthError(cause.message))
    return () => {
      live = false
    }
  }, [])

  // Floored at two seconds. A misconfigured 0 would otherwise turn this into a
  // busy loop against the daemon's single-threaded event loop.
  const refreshMs = Math.max(2, health?.config?.ui?.sidebar_refresh_s ?? DEFAULT_REFRESH_S) * 1000

  useEffect(() => {
    let live = true
    const tick = () =>
      fetchStatus()
        .then((next) => {
          if (!live) return
          setStatus(next)
          setStatusError('')
        })
        .catch((cause: Error) => live && setStatusError(cause.message))
    tick()
    const timer = window.setInterval(tick, refreshMs)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [refreshMs])

  const value = useMemo(
    () => ({ status, statusError, health, healthError, refreshMs }),
    [status, statusError, health, healthError, refreshMs],
  )
  return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>
}

export const useFeed = () => useContext(FeedContext)
