import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationSidebar } from './ConversationSidebar'
import type { CodeSession } from '../../lib/code-types'
import type { ModelEntry, Status } from '../../lib/types'

const RUNNING_SESSION: CodeSession = {
  id: 's-running',
  convId: 'c-running',
  title: 'Refactor the build pipeline',
  status: 'review',
  branch: 'main',
  when: '2m ago',
  add: 12,
  del: 3,
  createdAt: new Date().toISOString(),
  repoRoot: '/repo/turbollm',
  codeAgent: 'turbollm',
  running: true,
}

const IDLE_SESSION: CodeSession = {
  id: 's-idle',
  convId: 'c-idle',
  title: 'Fix the flaky test',
  status: 'review',
  branch: 'main',
  when: '1h ago',
  add: 4,
  del: 1,
  createdAt: new Date().toISOString(),
  repoRoot: '/repo/turbollm',
  codeAgent: 'turbollm',
  running: false,
}

// listCodeSessions is what useCodeSessions (ConversationSidebar's own CodeSessionsList) polls —
// mocking here is the ADR-256 scenario itself: a session running in the DAEMON background, with
// no locally-open SSE connection driving any client-side "generating" state for it.
vi.mock('../../lib/code-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/code-api')>()
  return {
    ...actual,
    listCodeSessions: vi.fn(async () => ({ sessions: [RUNNING_SESSION, IDLE_SESSION] })),
  }
})

const catalog: { status: Status | undefined; models: ModelEntry[] | undefined } = { status: undefined, models: undefined }

vi.mock('../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/queries')>()),
  useStatus: () => ({ data: catalog.status }),
  useModels: () => ({ data: catalog.models ? { models: catalog.models, scanning: false } : undefined }),
}))

function renderSidebar(collapsed = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/workspace/code']}>
        <ConversationSidebar activeId={null} onSelect={() => {}} onNew={() => {}} collapsed={collapsed} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  catalog.status = undefined
  catalog.models = undefined
})

// ADR-444, amended 2026-09-25: the playground is a Workspace tab beside Chat, Code and Routines, not a link under them.
describe('ConversationSidebar — the text classification tab', () => {
  const LAYA_LOADED = {
    textClassification: { key: 'laya-key', name: 'laya', runtime: 'laya', state: 'running', slot: 'pool', checkpoints: ['english'] },
    jev: null,
    laya: null,
  } as unknown as Status
  const LIBRARY_LAYA = { key: 'laya-key', name: 'laya', loaded: true, laya: { checkpoints: ['english'] } } as unknown as ModelEntry

  it('offers the playground inside the Workspace mode control, with no link under it', () => {
    catalog.status = LAYA_LOADED
    catalog.models = [LIBRARY_LAYA]
    renderSidebar()
    const group = screen.getByRole('group', { name: 'Workspace mode' })
    expect(within(group).getByRole('link', { name: /Text classification/ })).toHaveAttribute('href', '/workspace/text-classification')
    expect(screen.queryByText(/Open playground/)).toBeNull()
  })

  it('offers it as an icon in the collapsed rail', () => {
    catalog.status = LAYA_LOADED
    catalog.models = [LIBRARY_LAYA]
    renderSidebar(true)
    expect(screen.getByTitle('Text classification')).toHaveAttribute('href', '/workspace/text-classification')
    expect(screen.queryByTitle('Open the text classification playground')).toBeNull()
  })
})

describe('ConversationSidebar — background-running Code sessions (ADR-256)', () => {
  it('shows a live indicator for a session the daemon reports running, even with no tab open on it', async () => {
    renderSidebar()
    // Both sessions share the same underlying "Needs review" DB status (toSessionStatus
    // collapses running/queued to 'review') — only the live `running` flag tells them apart.
    // The running one gets a distinct "Running" label; the idle one keeps the plain status label.
    expect(await screen.findByText(/Running/)).toBeInTheDocument()
    expect(screen.getByText(/Needs review/)).toBeInTheDocument()
  })

  it('keeps the plain status label on a session that is not live, even though it shares the running one\'s DB status', async () => {
    renderSidebar()
    const idleTitle = await screen.findByText('Fix the flaky test')
    const idleRow = idleTitle.closest('[role="button"]')
    expect(idleRow).not.toBeNull()
    expect(idleRow).toHaveTextContent('Needs review')
    expect(idleRow).not.toHaveTextContent('Running')
  })
})
