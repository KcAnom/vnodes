/**
 * The things the map has to say out loud.
 *
 * Omission is the one that is an invariant rather than a nicety: a picture that
 * quietly leaves out 900 files reads as a complete picture of a small project.
 * There are now three ways a file can be left out — trimmed for size, filtered
 * for not being code, or outside the scoped directory — and each is stated
 * separately, next to the control that reverses it. Folding them together would
 * make each remedy wrong for two thirds of what it claimed to explain.
 */
import { AlertTriangle, EyeOff, FolderTree, Layers, RefreshCw } from 'lucide-react'
import { queryString } from './api'
import type { MapPayload, MapQuery } from './types'

export function Notices({ payload, query }: { payload: MapPayload; query: MapQuery }) {
  const filtered = payload.filtered.count
  const hasNotice =
    payload.dropped > 0 ||
    filtered > 0 ||
    payload.out_of_scope > 0 ||
    payload.cycles.length > 0 ||
    Boolean(payload.task)
  if (!hasNotice) return null

  const langs = Object.entries(payload.filtered.langs)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => `${count} ${lang}`)
    .join(', ')

  return (
    // Clear of the zoom column on the left: these notices sit above the canvas,
    // and at z-20 over controls at z-5 they made the zoom buttons unclickable in
    // exactly the sessions — trimmed, cyclic, capsule — where getting around the
    // graph matters most.
    <div className="scroll-thin absolute bottom-3 left-[56px] z-20 flex max-h-[38%] w-96 flex-col gap-2 overflow-y-auto">
      {payload.dropped > 0 && (
        <Notice icon={<AlertTriangle className="size-3.5" />} tone="accent">
          <b>
            Showing {payload.counts.files} of {payload.counts.files + payload.dropped} files
          </b>{' '}
          in scope, most-connected first — capsule pivots and the target first of all. The rest are
          not drawn. Scope the map with a target, or raise <code>ui.map_max_nodes</code>.
        </Notice>
      )}

      {payload.out_of_scope > 0 && (
        <Notice icon={<FolderTree className="size-3.5" />} tone="accent">
          <b>
            {payload.out_of_scope} file{payload.out_of_scope === 1 ? '' : 's'} outside{' '}
            <code>{payload.path}</code>
          </b>{' '}
          are not drawn.{' '}
          <a className="text-accent hover:underline" href={`/ui/map${queryString({ ...query, path: '' })}`}>
            draw the whole project →
          </a>
        </Notice>
      )}

      {filtered > 0 && (
        <Notice icon={<EyeOff className="size-3.5" />} tone="accent">
          <b>
            {filtered} non-code file{filtered === 1 ? '' : 's'}
          </b>
          {langs && ` (${langs})`} are not drawn — this map defaults to code, so the code is not
          crowded out by what documents it.{' '}
          <a
            className="text-accent hover:underline"
            href={`/ui/map${queryString({ ...query, show: 'all' })}`}
          >
            show all →
          </a>
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
