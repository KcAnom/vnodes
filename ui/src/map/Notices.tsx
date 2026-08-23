/**
 * The three things the map has to say out loud.
 *
 * Trimming is the one that is an invariant rather than a nicety: a picture that
 * quietly omits 900 files reads as a complete picture of a small project. The
 * old renderer stated it and so does this one.
 */
import { AlertTriangle, Layers, RefreshCw } from 'lucide-react'
import type { MapPayload } from './types'

export function Notices({ payload }: { payload: MapPayload }) {
  const hasNotice = payload.dropped > 0 || payload.cycles.length > 0 || Boolean(payload.task)
  if (!hasNotice) return null

  return (
    <div className="scroll-thin absolute bottom-3 left-3 z-20 flex max-h-[45%] w-96 flex-col gap-2 overflow-y-auto">
      {payload.dropped > 0 && (
        <Notice icon={<AlertTriangle className="size-3.5" />} tone="accent">
          <b>
            Showing {payload.counts.files} of {payload.counts.files + payload.dropped} files
          </b>{' '}
          in scope, most-connected first — capsule pivots and the target first of all. The rest are
          not drawn. Scope the map with a target, or raise <code>ui.map_max_nodes</code>.
        </Notice>
      )}

      {payload.task && (
        <Notice icon={<Layers className="size-3.5" />} tone="accent">
          <b>Capsule for:</b> {payload.task} — intent <code>{payload.intent}</code>. Pivots come
          through in full, skeleton files as signatures, everything else was left out.
          <div className="mt-1.5 font-mono text-[10px] break-all text-muted-foreground">
            vnodes pipeline "{payload.task}"
          </div>
        </Notice>
      )}

      {payload.cycles.length > 0 && (
        <Notice icon={<RefreshCw className="size-3.5" />} tone="danger">
          <b>
            {payload.cycles.length} import cycle{payload.cycles.length === 1 ? '' : 's'}.
          </b>{' '}
          Every file in one imports its way back to itself, so no dependency order exists among them.
          <ul className="mt-1.5 flex flex-col gap-0.5 font-mono text-[10px]">
            {payload.cycles.slice(0, 5).map((cycle) => (
              <li key={cycle.join('>')} className="break-all">
                {cycle.join(' → ')} → {cycle[0]}
              </li>
            ))}
          </ul>
          {payload.cycles.length > 5 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              …and {payload.cycles.length - 5} more.
            </p>
          )}
        </Notice>
      )}
    </div>
  )
}

function Notice({
  icon,
  tone,
  children,
}: {
  icon: React.ReactNode
  tone: 'accent' | 'danger'
  children: React.ReactNode
}) {
  return (
    <div className="surface flex gap-2 px-3 py-2.5 text-[12px] leading-relaxed">
      <span className={tone === 'danger' ? 'mt-0.5 text-red-400' : 'mt-0.5 text-accent'}>{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
