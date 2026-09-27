// Two or more views of one thing (ADR-439) as a pressed-state button group: the response or its curl,
// the questions as JSON or as a form.
import { cn } from '../../lib/utils'

interface ViewToggleProps<View extends string> {
  label: string
  views: readonly View[]
  viewLabels: Record<View, string>
  view: View
  onView: (next: View) => void
  /** Why a view cannot be picked right now, for each view that cannot. */
  unavailable?: Partial<Record<View, string>>
}

export function ViewToggle<View extends string>({ label, views, viewLabels, view, onView, unavailable = {} }: ViewToggleProps<View>) {
  return (
    <div className="inline-flex w-fit rounded-md border border-border p-0.5" role="group" aria-label={label}>
      {views.map((candidate) => (
        <button
          key={candidate}
          type="button"
          aria-pressed={view === candidate}
          disabled={unavailable[candidate] !== undefined}
          title={unavailable[candidate]}
          onClick={() => onView(candidate)}
          className={cn(
            'rounded px-3 py-1 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            view === candidate ? 'bg-accent/12 text-accent' : 'text-muted hover:text-ink',
          )}
        >
          {viewLabels[candidate]}
        </button>
      ))}
    </div>
  )
}
