// The process spawner that keeps CreateProcess off Electron's UI thread.
//
// `child_process.spawn` runs synchronously on the calling thread until the OS
// has created the process (CreateProcessW on Windows). In the main process the
// calling thread is the browser UI thread, so every git, gh or helper start
// held input, IPC and window moves for as long as the OS took: about 5 ms on a
// good day, seconds when an antivirus scan or a loaded machine slows process
// creation down. This module runs in an Electron utility process (or, when one
// is not available, a worker thread) and does the spawning there; the main
// process keeps a ChildProcess-shaped proxy per child (off-main-spawn.ts) and
// receives stdio and exit events as messages.
//
// Self-contained on purpose: Node built-ins only, and only erasable TypeScript,
// so the bundler can emit it as its own entry and a test can load the source in
// a worker thread directly.

import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process'
import { workerData, parentPort as workerParentPort } from 'node:worker_threads'

export interface SpawnHostRequest {
  t: 'spawn'
  id: number
  file: string
  args: string[]
  options: SpawnOptions & { stdio?: Array<'pipe' | 'ignore'> }
}

export type HostInbound =
  | SpawnHostRequest
  | { t: 'stdin'; id: number; data: Uint8Array }
  | { t: 'stdin-end'; id: number }
  | { t: 'kill'; id: number; signal?: NodeJS.Signals | number }

export type HostOutbound =
  | { t: 'spawned'; id: number; pid: number | undefined; heldMs: number }
  | { t: 'error'; id: number; error: SerializedError; heldMs: number }
  | { t: 'stdout' | 'stderr'; id: number; data: Uint8Array }
  | { t: 'stdin-error'; id: number; error: SerializedError }
  | { t: 'exit' | 'close'; id: number; code: number | null; signal: NodeJS.Signals | null; killed: boolean }

export interface SerializedError {
  message: string
  code?: string | number
  errno?: number
  syscall?: string
  path?: string
  spawnargs?: string[]
}

interface Port {
  post: (message: HostOutbound) => void
  listen: (handler: (message: HostInbound) => void) => void
}

export function serializeError(error: unknown): SerializedError {
  const e = (error || {}) as NodeJS.ErrnoException & { spawnargs?: string[] }

  return {
    message: String(e.message || error),
    code: e.code,
    errno: e.errno,
    syscall: e.syscall,
    path: e.path,
    spawnargs: Array.isArray(e.spawnargs) ? e.spawnargs.map(String) : undefined
  }
}

/** Serve spawn requests on `port` until the parent goes away. */
export function runSpawnHost(port: Port): void {
  const children = new Map<number, ChildProcess>()

  const start = (request: SpawnHostRequest) => {
    const t0 = performance.now()
    let child: ChildProcess

    try {
      child = spawn(request.file, request.args, request.options)
    } catch (error) {
      port.post({ t: 'error', id: request.id, error: serializeError(error), heldMs: performance.now() - t0 })

      return
    }

    const heldMs = performance.now() - t0
    children.set(request.id, child)

    // A failed start (ENOENT, EACCES) arrives as 'error' with no pid and no 'spawn'.
    child.once('spawn', () => port.post({ t: 'spawned', id: request.id, pid: child.pid, heldMs }))
    child.on('error', error => {
      if (child.pid === undefined) {
        port.post({ t: 'error', id: request.id, error: serializeError(error), heldMs })
      }
    })
    child.stdout?.on('data', (data: Buffer) => port.post({ t: 'stdout', id: request.id, data }))
    child.stderr?.on('data', (data: Buffer) => port.post({ t: 'stderr', id: request.id, data }))
    child.stdin?.on('error', error => port.post({ t: 'stdin-error', id: request.id, error: serializeError(error) }))
    child.once('exit', (code, signal) => port.post({ t: 'exit', id: request.id, code, signal, killed: child.killed }))
    child.once('close', (code, signal) => {
      children.delete(request.id)
      port.post({ t: 'close', id: request.id, code, signal, killed: child.killed })
    })
  }

  port.listen(message => {
    if (message.t === 'spawn') {
      start(message)

      return
    }

    const child = children.get(message.id)

    if (!child) {
      return
    }

    if (message.t === 'stdin') {
      child.stdin?.write(Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength))
    } else if (message.t === 'stdin-end') {
      child.stdin?.end()
    } else if (message.t === 'kill') {
      child.kill(message.signal)
    }
  })
}

// Entry: an Electron utility process has process.parentPort; a worker thread
// started by off-main-spawn.ts carries SPAWN_HOST_WORKER_MARK in workerData.
// Imported anywhere else (a test, a test runner's own worker) it does nothing.
export const SPAWN_HOST_WORKER_MARK = 'hermes-spawn-host'

interface ElectronParentPort {
  on: (event: 'message', handler: (event: { data: HostInbound }) => void) => void
  postMessage: (message: HostOutbound) => void
}

const electronPort = (process as unknown as { parentPort?: ElectronParentPort }).parentPort

if (electronPort) {
  runSpawnHost({
    post: message => electronPort.postMessage(message),
    listen: handler => electronPort.on('message', event => handler(event.data))
  })
} else if (workerParentPort && (workerData as { mark?: string } | null)?.mark === SPAWN_HOST_WORKER_MARK) {
  const port = workerParentPort

  runSpawnHost({
    post: message => port.postMessage(message),
    listen: handler => port.on('message', handler)
  })
}
