import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { useRepoWorktreeMap } from './model'

// The entered project is rebuilt on every tree refresh and live overlay, so the sidebar hands the probe a fresh array
// of the same repo paths many times a minute. A project whose folder holds many repos then re-ran `git worktree list`
// for every one of them on every rebuild (a live trace: 79 list/status runs in 3 minutes, up to 9 at once).
afterEach(() => {
  cleanup()
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

test('a new array of the same repo paths does not probe git again; a changed list does', async () => {
  const worktreeList = vi.fn(async (path: string) => [{ branch: 'main', detached: false, isMain: true, path }])

  ;(window as { hermesDesktop?: unknown }).hermesDesktop = { git: { worktreeList } }

  const { rerender, result } = renderHook(({ paths }) => useRepoWorktreeMap(paths, true), {
    initialProps: { paths: ['/dev/a', '/dev/b', '/dev/c'] }
  })

  await waitFor(() => expect(Object.keys(result.current[0])).toHaveLength(3))
  expect(worktreeList).toHaveBeenCalledTimes(3)

  for (let i = 0; i < 5; i += 1) {
    rerender({ paths: ['/dev/c', '/dev/a', '/dev/b'] }) // same list, new array, other order
  }

  await new Promise(resolve => setTimeout(resolve, 20))
  expect(worktreeList).toHaveBeenCalledTimes(3)

  rerender({ paths: ['/dev/a', '/dev/b', '/dev/c', '/dev/d'] })
  await waitFor(() => expect(Object.keys(result.current[0])).toHaveLength(4))
  expect(worktreeList).toHaveBeenCalledTimes(7)
})
