// The Workspace mode control, shared by the Workspace sidebar and the text classification playground's own left
// column so the two cannot drift. Chat | Code | Routines sit in one row; whenever the user has a text classification
// model, "Text classification" is a full-width second row of the same bordered control (ADR-444, amended
// 2026-09-25) — the sidebar is 224px wide, too narrow for a fourth segment. While a Jev model has taken the
// Workspace over (ADR-434 (i)(1)), Chat, Code and Routines are unreachable, so only that row is left.
import { AlarmClock, FlaskConical, MessageSquare, SquareTerminal, type LucideIcon } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { track } from '../lib/api'
import { TEXT_CLASSIFICATION_PATH, hasTextClassifier, jevPresence } from '../lib/jev-mode'
import { useCodeFeatureEnabled } from '../lib/platform'
import { useModels, useSettings, useStatus } from '../lib/queries'
import { loadedSystemOneModel } from '../lib/systemone-model'
import type { ModelEntry, Status } from '../lib/types'
import { cn, readLastChatConvId, readLastCodeSessionId } from '../lib/utils'

type WorkspaceMode = 'chat' | 'code' | 'routines' | 'text-classification'

type ModeTab = { mode: WorkspaceMode; href: string; label: string; icon: LucideIcon; onOpen?: () => void }

export function WorkspaceModeTabs({ collapsed = false }: { collapsed?: boolean }) {
  const rows = useModeRows()
  const active = workspaceModeOf(useLocation().pathname)
  if (collapsed) return <RailIcons tabs={rows.flat()} active={active} />
  return (
    <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border" role="group" aria-label="Workspace mode">
      {rows.map((tabs) => (
        <SegmentRow key={tabs[0].mode} tabs={tabs} active={active} />
      ))}
    </div>
  )
}

function useModeRows(): ModeTab[][] {
  const status = useStatus().data
  const models = useModels().data?.models
  const workTabs = useWorkTabs()
  const textClassificationTab = textClassificationTabFor(status, models)
  if (jevPresence(status, models) === 'loaded') return [[textClassificationTab]]
  return hasTextClassifier(status, models) ? [workTabs, [textClassificationTab]] : [workTabs]
}

/** Switching modes returns to the conversation or session last open in that mode, not to its root. */
function useWorkTabs(): ModeTab[] {
  // Experimental and off by default (Settings → Experimental): the tab is omitted, not disabled, and App.tsx's own
  // route gate stops a stale link or typed URL from reaching Routines anyway.
  const routinesEnabled = useSettings().query.data?.experimental?.routines ?? false
  // Code is cut from the Android release (platform.ts). `=== true` is load-bearing: the hook's third state is
  // "sysinfo hasn't answered yet", and rendering the tab through it would flash Code onto the Android app.
  const codeEnabled = useCodeFeatureEnabled() === true
  return [
    { mode: 'chat', href: lastPathIn('/workspace/chat', readLastChatConvId()), label: 'Chat', icon: MessageSquare },
    ...(codeEnabled ? [codeTab()] : []),
    ...(routinesEnabled ? [routinesTab()] : []),
  ]
}

function codeTab(): ModeTab {
  return { mode: 'code', href: lastPathIn('/workspace/code', readLastCodeSessionId()), label: 'Code', icon: SquareTerminal }
}

function routinesTab(): ModeTab {
  return { mode: 'routines', href: '/workspace/routines', label: 'Routines', icon: AlarmClock }
}

function lastPathIn(section: string, lastOpenId: string | null): string {
  return lastOpenId ? `${section}/${lastOpenId}` : section
}

/** Opening the playground for a loaded Laya model keeps the event the old sidebar link recorded (ADR-444: telemetry
 *  names are kept). */
function textClassificationTabFor(status: Status | undefined, models: ModelEntry[] | undefined): ModeTab {
  const onOpen = layaIsLoaded(status, models) ? () => track('workspace', 'open_laya_playground') : undefined
  return { mode: 'text-classification', href: TEXT_CLASSIFICATION_PATH, label: 'Text classification', icon: FlaskConical, onOpen }
}

function layaIsLoaded(status: Status | undefined, models: ModelEntry[] | undefined): boolean {
  return loadedSystemOneModel(status, models)?.checkpoints !== undefined
}

function workspaceModeOf(pathname: string): WorkspaceMode {
  if (pathname.startsWith(TEXT_CLASSIFICATION_PATH)) return 'text-classification'
  if (pathname.startsWith('/workspace/routines')) return 'routines'
  return pathname.startsWith('/workspace/code') ? 'code' : 'chat'
}

function SegmentRow({ tabs, active }: { tabs: ModeTab[]; active: WorkspaceMode }) {
  return (
    <div className="flex">
      {tabs.map(({ mode, href, label, icon: Icon, onOpen }) =>
        mode === active ? (
          <span
            key={mode}
            aria-current="page"
            className="flex flex-auto items-center justify-center gap-1 px-1.5 py-1.5 text-[12px] font-medium"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
          >
            <Icon size={13} /> {label}
          </span>
        ) : (
          <Link
            key={mode}
            to={href}
            onClick={onOpen}
            className="flex flex-auto items-center justify-center gap-1 px-1.5 py-1.5 text-[12px] font-medium text-muted transition-colors hover:bg-panel hover:text-ink"
          >
            <Icon size={13} /> {label}
          </Link>
        ),
      )}
    </div>
  )
}

/** The collapsed rail's icon form — the same active treatment as the app's own NavRail (Shell.tsx). */
function RailIcons({ tabs, active }: { tabs: ModeTab[]; active: WorkspaceMode }) {
  return (
    <>
      {tabs.map(({ mode, href, label, icon: Icon, onOpen }) => (
        <Link
          key={mode}
          to={href}
          title={label}
          onClick={onOpen}
          aria-current={mode === active ? 'page' : undefined}
          className={cn(
            'grid h-7 w-7 place-items-center rounded-md transition-colors',
            mode === active ? 'bg-accent/12 text-accent' : 'text-muted hover:bg-panel hover:text-ink',
          )}
        >
          <Icon size={15} />
        </Link>
      ))}
    </>
  )
}
