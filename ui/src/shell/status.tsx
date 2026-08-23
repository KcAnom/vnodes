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
 *
 * The registry listing joined it for the same reason the `/status` poll is
 * here. Three components want it at once — the rail's KB switcher, the shell's
 * unknown-`kb` guard, and the picker itself — and three components fetching it
 * independently would be three answers that can disagree, on the one page whose
 * entire job is to say what exists. It is not polled: `/ui/api/kbs` walks the
 * registry and stats two paths per row, and a registry only changes when an
 * agent indexes something new. It is fetched on mount and again when the window
 * regains focus, with a floor of ten seconds between fetches so alt-tabbing
 * cannot turn a focus handler into a poll.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchHealth, fetchKbs, fetchStatus } from './api'
import type { Health, KbList, Status } from './api'

/** What the config ships as, and what is used when the health call is refused. */
const DEFAULT_REFRESH_S = 10

/** The shortest gap between two registry reads, however often focus fires. */
const KBS_MIN_GAP_MS = 10_000

export type Feed = {
  status: Status | null
  statusError: string
  health: Health | null
  healthError: string
  refreshMs: number
  /** The registry listing, or null while it is in flight or refused. */
  kbs: KbList | null
  /**
   * Why the registry could not be read. A daemon that predates the registry
   * answers `/ui/api/kbs` with the api index, so this is a real and expected
   * state rather than a bug — and every reader of it degrades to what it did
   * before rather than blocking the page on it.
   */
  kbsError: string
}

const FeedContext = createContext<Feed>({
  status: null,
  statusError: '',
  health: null,
  healthError: '',
  refreshMs: DEFAULT_REFRESH_S * 1000,
  kbs: null,
  kbsError: '',
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

  const [kbs, setKbs] = useState<KbList | null>(null)
  const [kbsError, setKbsError] = useState('')
  const lastKbs = useRef(0)
  const alive = useRef(true)

  const readKbs = useCallback(() => {
    const now = Date.now()
    if (now - lastKbs.current < KBS_MIN_GAP_MS) return
    lastKbs.current = now
    fetchKbs()
      .then((next) => {
        if (!alive.current) return
        setKbs(next)
        setKbsError('')
      })
      .catch((cause: Error) => alive.current && setKbsError(cause.message))
  }, [])

  useEffect(() => {
    alive.current = true
    readKbs()
    window.addEventListener('focus', readKbs)
    return () => {
      alive.current = false
      window.removeEventListener('focus', readKbs)
    }
  }, [readKbs])

  const value = useMemo(
    () => ({ status, statusError, health, healthError, refreshMs, kbs, kbsError }),
    [status, statusError, health, healthError, refreshMs, kbs, kbsError],
  )
  return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>
}

export const useFeed = () => useContext(FeedContext)
