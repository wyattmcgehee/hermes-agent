// Test helpers for off-main-spawn.test.ts: model the Windows condition where the
// OS takes a long time to create a process. CreateProcessW runs synchronously on
// the thread that calls spawn(), so the model holds that thread for `holdMs`
// inside ChildProcess.prototype.spawn, wherever it is called.
//
// Loaded two ways: imported by the test (holdSpawnCalls for the test's own
// thread), and as a worker-thread entry (workerData.holdMs set), where it holds
// the worker's spawns and then runs spawn-host.ts in the same worker.

import { ChildProcess } from 'node:child_process'
import { workerData } from 'node:worker_threads'

function busyWait(ms: number): void {
  const end = performance.now() + ms

  while (performance.now() < end) {
    // A blocked thread, as inside a slow CreateProcessW.
  }
}

/** Hold every process creation on the calling thread for `holdMs`. Returns the undo. */
export function holdSpawnCalls(holdMs: number): () => void {
  const proto = ChildProcess.prototype as unknown as { spawn: (...args: unknown[]) => unknown }
  const original = proto.spawn

  proto.spawn = function (this: unknown, ...args: unknown[]) {
    busyWait(holdMs)

    return original.apply(this, args)
  }

  return () => {
    proto.spawn = original
  }
}

const hold = (workerData as { holdMs?: number } | null)?.holdMs

if (typeof hold === 'number') {
  holdSpawnCalls(hold)
  void import(new URL('./spawn-host.ts', import.meta.url).href)
}
