import { expect, test } from 'vitest'

import { createGitReadCoalescer, GIT_READ_JOIN_MS, NEGATIVE_MAX_MS, NEGATIVE_MIN_MS } from './git-read-coalescer'

// Edges in a tool-heavy turn arrive faster than a git read finishes. Reads of one repo must never run side by side
// (a live trace held 9 `worktree list` runs of one repo at once): a request after the join window shares one trailing
// run that starts when the current one settles, so a burst costs at most two runs and nothing answers with a tree
// read before the request was made.
function harness() {
  let clock = 0
  let running = 0
  let peak = 0
  const runs: Array<() => void> = []
  const reads = createGitReadCoalescer(() => clock)

  const run = () => {
    running += 1
    peak = Math.max(peak, running)

    return new Promise<number>(resolve => {
      const id = runs.length

      runs.push(() => {
        running -= 1
        resolve(id)
      })
    })
  }

  return {
    advance: (ms: number) => (clock += ms),
    finish: async (i: number) => {
      runs[i]()
      await new Promise(r => setTimeout(r, 0))
    },
    peak: () => peak,
    read: () => reads.read('status:/repo', run),
    reads,
    runs
  }
}

test('a burst of reads after the join window shares one trailing run, never a second run beside the first', async () => {
  const h = harness()
  const first = h.read()

  h.advance(GIT_READ_JOIN_MS + 1)
  const later = [h.read(), h.read(), h.read(), h.read()]

  expect(h.runs).toHaveLength(1)
  await h.finish(0)
  expect(h.runs).toHaveLength(2) // the trailing run starts only now
  await h.finish(1)

  expect(await first).toBe(0)
  expect(await Promise.all(later)).toEqual([1, 1, 1, 1])
  expect(h.peak()).toBe(1)
})

test('reads within the join window share the run in flight', async () => {
  const h = harness()
  const a = h.read()

  h.advance(GIT_READ_JOIN_MS)
  const b = h.read()

  await h.finish(0)
  expect(await Promise.all([a, b])).toEqual([0, 0])
  expect(h.runs).toHaveLength(1)
})

test('after a mutation the next read starts at once; a settled run is never reused', async () => {
  const h = harness()
  const a = h.read()

  h.reads.invalidate()
  const b = h.read()

  expect(h.runs).toHaveLength(2)
  await h.finish(0)
  await h.finish(1)
  expect(await Promise.all([a, b])).toEqual([0, 1])

  const c = h.read()

  expect(h.runs).toHaveLength(3)
  await h.finish(2)
  expect(await c).toBe(2)
})

test('a failed run does not wedge the trailing readers', async () => {
  const reads = createGitReadCoalescer(() => 0)
  let clock = 0
  const timed = createGitReadCoalescer(() => clock)
  const failing = timed.read('k', () => Promise.reject(new Error('git failed')))

  clock = GIT_READ_JOIN_MS + 1
  const trailing = timed.read('k', () => Promise.resolve('ok'))

  await expect(failing).rejects.toThrow('git failed')
  expect(await trailing).toBe('ok')
  expect(await reads.read('x', () => Promise.resolve(1))).toBe(1)
})

// A project folder that is not a repo (or a parent of many repos) is asked on every edge and can only answer empty.
test('an empty answer is kept with a doubling backoff; a real answer and a mutation clear it', async () => {
  let clock = 0
  let calls = 0
  let answer: string[] = []
  const reads = createGitReadCoalescer(() => clock)
  const isEmpty = (v: string[]) => v.length === 0

  const list = () =>
    reads.read(
      'worktreeList:/not-a-repo',
      async () => {
        calls += 1

        return answer
      },
      isEmpty
    )

  expect(await list()).toEqual([])
  expect(calls).toBe(1)

  clock += NEGATIVE_MIN_MS - 1
  expect(await list()).toEqual([]) // within the window: no git
  expect(calls).toBe(1)

  clock += 1
  await list() // window over: asks again, still empty, so the next window doubles
  expect(calls).toBe(2)
  clock += 2 * NEGATIVE_MIN_MS - 1
  await list()
  expect(calls).toBe(2)
  clock += 1
  await list()
  expect(calls).toBe(3)

  reads.invalidate() // a desktop mutation (e.g. worktree add) re-asks at once
  answer = ['/not-a-repo']
  expect(await list()).toEqual(['/not-a-repo'])
  expect(calls).toBe(4)

  expect(await list()).toEqual(['/not-a-repo']) // a real answer is never reused
  expect(calls).toBe(5)
})

test('the backoff is capped, and reads without isEmpty are never answered from it', async () => {
  let clock = 0
  let calls = 0
  const reads = createGitReadCoalescer(() => clock)

  const ask = async () => {
    calls += 1

    return null
  }

  const empty = () => reads.read('k', ask, v => v === null)

  for (let i = 0; i < 12; i += 1) {
    await empty()
    clock += NEGATIVE_MAX_MS
  }

  expect(calls).toBe(12) // each window is at most NEGATIVE_MAX_MS

  const before = calls

  await reads.read('k', ask)
  expect(calls).toBe(before + 1)
})
