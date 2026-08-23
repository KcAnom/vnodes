/**
 * The one text input. Copied from nodekit's `src/kit/ui/input.tsx`, which
 * imports nothing but `cn` and is near-identical to the class string
 * `map/Toolbar.tsx` had hand-rolled twice.
 *
 * Nothing else from the kit's `ui/` follows it: `button.tsx` drags in
 * `@radix-ui/react-slot` and `class-variance-authority` for an `asChild` prop
 * nothing here uses, `dialog.tsx` has nothing to put in a modal in a read-only
 * app, and `tooltip.tsx` needs a provider at the root and its own keyframes to
 * replace a native `title`, which is already reachable by keyboard and by a
 * screen reader. Zero runtime dependencies is vnodes' guarantee at the package
 * boundary; keeping this tree's own dependency list short is the same instinct
 * one level in.
 */
import type { ComponentProps } from 'react'
import { cn } from '../kit/utils'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'rounded border border-border bg-background px-2 py-1 text-[12px] text-foreground outline-none transition-colors duration-150 placeholder:text-muted-foreground focus:border-border-active',
        className,
      )}
      {...props}
    />
  )
}
