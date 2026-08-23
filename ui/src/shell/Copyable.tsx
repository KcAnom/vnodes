/**
 * A command the reader is meant to run somewhere else.
 *
 * Three pages need this and they need it for the same reason: the UI is
 * read-only by construction. It diagnoses; the operator applies. So the remedy
 * for a failed doctor check, the `vnodes pipeline` line that reproduces a
 * capsule, and the `.vnodesignore` line that would drop 181 files out of the
 * index are all rendered as text you can take with you, and never as a button
 * that does it for you. A button that wrote would be a shorter path and a
 * broken promise.
 *
 * Copying is the one thing this can do without breaking that: the clipboard is
 * the reader's, not the project's. Where the clipboard is unavailable — an
 * insecure origin, a browser that refuses — the text is still there to select,
 * which is what it was before this was a button.
 */
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '../kit/utils'

export function Copyable({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={copied ? 'copied' : 'copy'}
      onClick={() => {
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1200)
          })
          .catch(() => undefined)
      }}
      className={cn(
        'group inline-flex max-w-full items-center gap-1.5 rounded border border-border bg-card px-1.5 py-0.5 text-left align-middle font-mono text-[11px] hover:bg-panel-hover',
        className,
      )}
    >
      <span className="min-w-0 break-all">{text}</span>
      {copied ? (
        <Check className="size-3 shrink-0 text-emerald-400" />
      ) : (
        <Copy className="size-3 shrink-0 text-muted-foreground" />
      )}
    </button>
  )
}
