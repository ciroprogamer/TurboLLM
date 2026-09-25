// The way into the text classification playground while a Laya model is loaded (ADR-443, ADR-444). A Jev model takes the whole
// Workspace over and so needs no link; a Laya model runs beside the chat model, and the "ready" toast is gone once
// dismissed, so the Workspace sidebar carries this for as long as one is loaded or loading.
import { ArrowRight, FlaskConical } from 'lucide-react'
import { Link } from 'react-router-dom'
import { track } from '../lib/api'
import { TEXT_CLASSIFICATION_PATH, jevPresence } from '../lib/jev-mode'
import { useModels, useStatus } from '../lib/queries'
import { loadedSystemOneModel } from '../lib/systemone-model'

const TITLE = 'Open the text classification playground'

export function PlaygroundLink({ collapsed = false }: { collapsed?: boolean }) {
  const status = useStatus().data
  const models = useModels().data?.models
  const model = loadedSystemOneModel(status, models)
  if (!model || jevPresence(status, models) === 'loaded') return null
  const onClick = () => track('workspace', 'open_laya_playground')

  if (collapsed) {
    return (
      <Link
        to={TEXT_CLASSIFICATION_PATH}
        title={TITLE}
        aria-label={TITLE}
        onClick={onClick}
        className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-panel hover:text-ink"
      >
        <FlaskConical size={15} />
      </Link>
    )
  }
  return (
    <Link
      to={TEXT_CLASSIFICATION_PATH}
      title={TITLE}
      onClick={onClick}
      className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-[12px] text-muted transition-colors hover:bg-panel hover:text-ink"
    >
      <FlaskConical size={13} className="shrink-0" />
      <span className="flex-1 truncate">{`${model.name} · Open playground`}</span>
      <ArrowRight size={13} className="shrink-0" />
    </Link>
  )
}
