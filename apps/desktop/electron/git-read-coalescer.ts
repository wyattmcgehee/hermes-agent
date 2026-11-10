// One git read per repo at a time, whoever asks. Every surface that shows a repo (the main pane's coding rail, each
// session tile, the sidebar's worktree lanes, each open window) re-reads git on the same structural edges (cwd change,
// session switch, turn settle, a file-changing tool finishing), and in a tool-heavy turn those edges arrive faster
// than a read finishes. Each read is one or more child processes, and on Windows every `spawn` (CreateProcess) runs on
// the browser UI thread. Without a limit, reads of one repo piled up (a live trace held 9 `worktree list` runs of one
// repo at once).
//
// Per key (operation, git binary, repo path):
// - a read that starts within GIT_READ_JOIN_MS of the run in flight shares it (callers reacting to the same edge);
// - a later read never starts a second run beside it: it shares ONE trailing run that starts when the current one
//   settles, so it still sees the tree as of after its request, and a burst of N requests costs at most two runs;
// - a desktop git mutation (stage, commit, worktree add, branch switch, ...) fences every run that began before it:
//   the next read starts fresh at once.
// A real answer is never reused after its run settles: the callers are edge-driven, not timer-driven, so a reused
// stale answer would stay on screen until the next edge.
//
// The one exception is the EMPTY answer (`isEmpty`: no worktrees, no status), which is what a folder that is not a
// git repository gets every time. A project folder that is not a repo (or a parent folder of many repos) is asked on
// every edge like a repo is, so without a memory each edge cost a git process that could only fail again. An empty
// answer is kept for NEGATIVE_MIN_MS, doubling while it stays empty up to NEGATIVE_MAX_MS; any non-empty answer and
// any desktop mutation clear it. A folder that becomes a repo outside the app (`git init`) shows within that window.

export const GIT_READ_JOIN_MS = 100
export const NEGATIVE_MIN_MS = 15_000
export const NEGATIVE_MAX_MS = 300_000

interface Slot {
  generation: number
  running: Promise<unknown> | null
  startedAt: number
  trailing: Promise<unknown> | null
}

interface Negative {
  delayMs: number
  generation: number
  until: number
  value: unknown
}

export interface GitReadCoalescer {
  /** Mark a git mutation: no read issued after this shares a run that started before it. */
  invalidate: () => void
  /** `isEmpty` marks an answer that may be kept (with backoff) instead of re-asking git: see the header. */
  read: <T>(key: string, run: () => Promise<T>, isEmpty?: (value: T) => boolean) => Promise<T>
}

export function createGitReadCoalescer(now: () => number = Date.now): GitReadCoalescer {
  const slots = new Map<string, Slot>()
  const negatives = new Map<string, Negative>()
  let generation = 0

  const start = <T>(key: string, slot: Slot, run: () => Promise<T>, isEmpty?: (value: T) => boolean): Promise<T> => {
    const startedIn = generation

    const promise: Promise<T> = run()
      .then(value => {
        if (isEmpty) {
          remember(key, value, isEmpty(value), startedIn)
        }

        return value
      })
      .finally(() => {
        if (slot.running === promise) {
          slot.running = null

          if (!slot.trailing && slots.get(key) === slot) {
            slots.delete(key)
          }
        }
      })

    slot.generation = generation
    slot.running = promise
    slot.startedAt = now()

    return promise
  }

  const remember = (key: string, value: unknown, empty: boolean, startedIn: number) => {
    if (!empty) {
      negatives.delete(key)

      return
    }

    // A run that began before a mutation says nothing about the tree after it.
    if (startedIn !== generation) {
      return
    }

    const previous = negatives.get(key)

    const delayMs =
      previous && previous.generation === generation ? Math.min(previous.delayMs * 2, NEGATIVE_MAX_MS) : NEGATIVE_MIN_MS

    negatives.set(key, { delayMs, generation, until: now() + delayMs, value })
  }

  return {
    invalidate: () => {
      generation += 1
    },
    read: <T>(key: string, run: () => Promise<T>, isEmpty?: (value: T) => boolean): Promise<T> => {
      const negative = isEmpty ? negatives.get(key) : undefined

      if (negative && negative.generation === generation && now() < negative.until) {
        return Promise.resolve(negative.value as T)
      }

      let slot = slots.get(key)

      if (!slot) {
        slot = { generation, running: null, startedAt: 0, trailing: null }
        slots.set(key, slot)
      }

      const current = slot.running && slot.generation === generation ? slot.running : null

      if (!current) {
        return start(key, slot, run, isEmpty)
      }

      if (now() - slot.startedAt <= GIT_READ_JOIN_MS) {
        return current as Promise<T>
      }

      if (!slot.trailing) {
        const owner = slot

        owner.trailing = current
          .catch(() => undefined)
          .then(() => {
            owner.trailing = null

            return start(key, owner, run, isEmpty)
          })
      }

      return slot.trailing as Promise<T>
    }
  }
}
