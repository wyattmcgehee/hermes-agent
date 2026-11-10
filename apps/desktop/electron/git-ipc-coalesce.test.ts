import { beforeEach, expect, test, vi } from 'vitest'

import type * as ReviewOps from './git-review-ops'
import type * as WorktreeOps from './git-worktree-ops'

// Several surfaces re-read the same repo on one edge (the main rail, a tile on the same worktree,
// the sidebar's worktree lanes, a second window). Each read is several git processes whose spawn
// runs on Electron's main thread, so reads of one repo that start together must share one run;
// a desktop git mutation in between must not let a later read reuse a run from before it.
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) }
}))

const ops = vi.hoisted(() => ({
  listWorktrees: vi.fn(),
  repoStatus: vi.fn(),
  reviewStage: vi.fn()
}))

vi.mock('./git-review-ops', async importOriginal => ({
  ...(await importOriginal<typeof ReviewOps>()),
  repoStatus: ops.repoStatus,
  reviewStage: ops.reviewStage
}))

vi.mock('./git-worktree-ops', async importOriginal => ({
  ...(await importOriginal<typeof WorktreeOps>()),
  listWorktrees: ops.listWorktrees
}))

const { registerGitIpc } = await import('./git-ipc')

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })

  return { promise, resolve }
}

const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerGitIpc({ resolveGhBinary: () => 'gh', resolveGitBinary: () => 'git' })
})

test('concurrent status reads of one repo share one git run', async () => {
  const run = deferred<{ branch: string }>()
  ops.repoStatus.mockReturnValue(run.promise)

  const reads = [
    invoke('hermes:git:repoStatus', '/repo'),
    invoke('hermes:git:repoStatus', '/repo'),
    invoke('hermes:git:repoStatus', '/repo')
  ]
  run.resolve({ branch: 'main' })

  expect(await Promise.all(reads)).toEqual([{ branch: 'main' }, { branch: 'main' }, { branch: 'main' }])
  expect(ops.repoStatus).toHaveBeenCalledTimes(1)
})

test('concurrent worktree lists of one repo share one git run; other repos run their own', async () => {
  ops.listWorktrees.mockResolvedValue([])

  await Promise.all([
    invoke('hermes:git:worktreeList', '/repo'),
    invoke('hermes:git:worktreeList', '/repo'),
    invoke('hermes:git:worktreeList', '/other')
  ])

  expect(ops.listWorktrees.mock.calls.map(([repo]) => repo)).toEqual(['/repo', '/other'])
})

test('a read after the run settled, or after a desktop mutation, starts a fresh run', async () => {
  ops.repoStatus.mockResolvedValue({ branch: 'main' })
  await invoke('hermes:git:repoStatus', '/repo')
  await invoke('hermes:git:repoStatus', '/repo')
  expect(ops.repoStatus).toHaveBeenCalledTimes(2)

  const slow = deferred<{ branch: string }>()
  ops.repoStatus.mockReturnValueOnce(slow.promise)
  const before = invoke('hermes:git:repoStatus', '/repo')
  ops.reviewStage.mockResolvedValue({ ok: true })
  await invoke('hermes:git:review:stage', '/repo', 'a.txt')
  const after = invoke('hermes:git:repoStatus', '/repo')
  slow.resolve({ branch: 'main' })
  await Promise.all([before, after])

  expect(ops.repoStatus).toHaveBeenCalledTimes(4)
})
