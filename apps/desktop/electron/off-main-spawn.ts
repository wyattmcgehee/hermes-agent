// spawn and execFile for the Electron main process that do not create the
// process on the UI thread.
//
// On Windows `child_process.spawn` holds its calling thread until
// CreateProcessW returns, and the OS sometimes takes seconds for that (19 to 39
// s measured for plain git.exe and gh.exe starts on a loaded PC). In the main
// process the calling thread is the browser UI thread, so input, IPC and window
// moves stopped while the main process sat at a few percent CPU. Once
// startSpawnHost() has run, these functions hand the start to spawn-host.ts in
// an Electron utility process and return a ChildProcess-shaped proxy whose
// stdio and events arrive as messages. Before that (early startup, tests) and
// whenever the host is unavailable they are exactly node:child_process.

import {
  type ChildProcess,
  type ExecFileOptions,
  execFile as nodeExecFile,
  spawn as nodeSpawn,
  type SpawnOptions
} from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'

import type { HostInbound, HostOutbound, SerializedError } from './spawn-host'

// Mirrors spawn-host.ts SPAWN_HOST_WORKER_MARK (a value import would put the
// host's entry code into the main bundle).
const SPAWN_HOST_WORKER_MARK = 'hermes-spawn-host'

/** The message channel to one spawn host: a utility process or a worker thread. */
export interface SpawnHostTransport {
  post: (message: HostInbound) => void
  onMessage: (handler: (message: HostOutbound) => void) => void
  onExit: (handler: (code: number | null) => void) => void
  kill: () => void
}

interface HostState {
  transport: SpawnHostTransport
  children: Map<number, RemoteChildProcess>
}

let host: HostState | null = null
let hostFactory: (() => SpawnHostTransport) | null = null
let hostLog: (line: string) => void = () => undefined
let hostDeaths = 0
let nextId = 0
const MAX_HOST_DEATHS = 3
const SLOW_START_LOG_MS = 1_000

/** A utility process speaking the host protocol (Electron's utilityProcess.fork result). */
export interface UtilityProcessLike {
  postMessage: (message: HostInbound) => void
  on: ((event: 'message', handler: (message: HostOutbound) => void) => unknown) &
    ((event: 'exit', handler: (code: number) => void) => unknown)
  kill: () => boolean
}

export function utilityProcessTransport(child: UtilityProcessLike): SpawnHostTransport {
  return {
    post: message => child.postMessage(message),
    onMessage: handler => void child.on('message', handler),
    onExit: handler => void child.on('exit', handler),
    kill: () => void child.kill()
  }
}

/** A worker thread running spawn-host (tests, or a main process without utilityProcess). */
export function workerTransport(hostPath: string | URL, data: Record<string, unknown> = {}): SpawnHostTransport {
  const worker = new Worker(hostPath, { workerData: { ...data, mark: SPAWN_HOST_WORKER_MARK } })
  worker.unref()

  return {
    post: message => worker.postMessage(message),
    onMessage: handler => void worker.on('message', handler),
    onExit: handler => void worker.on('exit', handler),
    kill: () => void worker.terminate()
  }
}

/**
 * Route spawn/execFile from this module through a host. `create` is called now
 * and again after an unexpected host exit, up to MAX_HOST_DEATHS times; after
 * that every start runs in-process again.
 */
export function startSpawnHost(create: () => SpawnHostTransport, log: (line: string) => void = () => undefined): void {
  stopSpawnHost()
  hostFactory = create
  hostLog = log
  hostDeaths = 0
  connect()
}

/** Stop the host. Children it already started keep running; their pids stay valid. */
export function stopSpawnHost(): void {
  hostFactory = null

  if (host) {
    const current = host
    host = null
    current.transport.kill()
  }
}

export function spawnHostActive(): boolean {
  return host !== null
}

function connect(): void {
  if (!hostFactory) {
    return
  }

  let transport: SpawnHostTransport

  try {
    transport = hostFactory()
  } catch (error) {
    hostLog(`[spawn-host] could not start; spawning in the main process: ${(error as Error)?.message || error}`)
    hostFactory = null

    return
  }

  const state: HostState = { transport, children: new Map() }
  host = state
  transport.onMessage(message => state.children.get(message.id)?.receive(message))
  transport.onExit(code => {
    for (const child of [...state.children.values()]) {
      child.hostLost()
    }

    state.children.clear()

    // A host that was stopped or replaced is not restarted.
    if (host !== state) {
      return
    }

    host = null

    if (hostFactory && ++hostDeaths <= MAX_HOST_DEATHS) {
      hostLog(`[spawn-host] exited (${code}); restarting`)
      connect()
    } else if (hostFactory) {
      hostLog(`[spawn-host] exited (${code}) ${hostDeaths} times; spawning in the main process from now on`)
      hostFactory = null
    }
  })
}

function deserializeError(error: SerializedError): NodeJS.ErrnoException {
  return Object.assign(new Error(error.message), {
    code: error.code as string | undefined,
    errno: error.errno,
    syscall: error.syscall,
    path: error.path,
    spawnargs: error.spawnargs
  })
}

function hostStdio(options: SpawnOptions): Array<'pipe' | 'ignore'> {
  const raw = options.stdio ?? 'pipe'
  const list = typeof raw === 'string' ? [raw, raw, raw] : [...raw]

  // Only pipes cross the process boundary; anything else (inherit, a stream, an
  // fd) has no meaning in the host, so it is not opened there.
  return [0, 1, 2].map(fd =>
    list[fd] === 'pipe' || list[fd] === 'overlapped' || list[fd] === undefined ? 'pipe' : 'ignore'
  )
}

function plainEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const out: Record<string, string> = {}

  for (const [key, value] of Object.entries(env ?? process.env)) {
    if (value !== undefined) {
      out[key] = String(value)
    }
  }

  return out
}

/** The main-process face of a child the host started. Shaped like ChildProcess. */
class RemoteChildProcess extends EventEmitter {
  pid: number | undefined = undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  connected = false
  readonly spawnfile: string
  readonly spawnargs: string[]
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  readonly stdio: [Writable | null, Readable | null, Readable | null]
  private done = false

  constructor(
    private readonly id: number,
    private readonly state: HostState,
    file: string,
    args: string[],
    stdio: Array<'pipe' | 'ignore'>
  ) {
    super()
    this.spawnfile = file
    this.spawnargs = [file, ...args]
    const readable = () => new Readable({ read() {} })
    this.stdout = stdio[1] === 'pipe' ? readable() : null
    this.stderr = stdio[2] === 'pipe' ? readable() : null
    this.stdin =
      stdio[0] === 'pipe'
        ? new Writable({
            write: (chunk: Buffer, _encoding, callback) => {
              this.send({ t: 'stdin', id, data: chunk })
              callback()
            },
            final: callback => {
              this.send({ t: 'stdin-end', id })
              callback()
            }
          })
        : null
    this.stdio = [this.stdin, this.stdout, this.stderr]
  }

  private send(message: HostInbound): void {
    if (!this.done) {
      this.state.transport.post(message)
    }
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.done || this.exitCode !== null || this.signalCode !== null) {
      return false
    }

    this.killed = true
    this.send({ t: 'kill', id: this.id, signal })

    return true
  }

  ref(): void {}
  unref(): void {}
  disconnect(): void {}

  // An 'error' nobody listens for would throw in the main process and take the
  // app down; node:child_process callers that relied on a synchronous throw
  // instead see it logged.
  private emitError(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error)
    } else {
      hostLog(`[spawn-host] unhandled child error for ${this.spawnfile}: ${error.message}`)
    }
  }

  receive(message: HostOutbound): void {
    switch (message.t) {
      case 'spawned':
        this.pid = message.pid

        if (message.heldMs >= SLOW_START_LOG_MS) {
          hostLog(`[spawn-host] starting ${this.spawnfile} took ${Math.round(message.heldMs)} ms (off the UI thread)`)
        }

        this.emit('spawn')

        break

      case 'error':
        this.emitError(deserializeError(message.error))

        break

      case 'stdout':
        this.stdout?.push(Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength))

        break

      case 'stderr':
        this.stderr?.push(Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength))

        break

      case 'stdin-error':
        this.stdin?.destroy(deserializeError(message.error))

        break

      case 'exit':
        this.exitCode = message.code
        this.signalCode = message.signal
        this.killed = this.killed || message.killed
        this.emit('exit', message.code, message.signal)

        break

      case 'close':
        this.finish(message.code, message.signal, message.killed)

        break
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null, killed: boolean): void {
    if (this.done) {
      return
    }

    this.done = true
    this.state.children.delete(this.id)
    this.killed = this.killed || killed
    this.stdout?.push(null)
    this.stderr?.push(null)
    this.stdin?.destroy()
    // As in node, 'close' comes after the stdio streams have delivered their data.
    setImmediate(() => this.emit('close', code, signal))
  }

  hostLost(): void {
    if (this.done) {
      return
    }

    this.emitError(Object.assign(new Error('spawn host exited'), { code: 'ESPAWNHOST' }))
    this.finish(this.exitCode, this.signalCode, this.killed)
  }
}

function spawnImpl(command: string, args?: readonly string[] | SpawnOptions, options?: SpawnOptions): ChildProcess {
  if (!Array.isArray(args)) {
    options = args as SpawnOptions | undefined
    args = []
  }

  const argv = [...(args as readonly string[])].map(String)
  const opts: SpawnOptions = options ?? {}
  const state = host

  if (!state) {
    return nodeSpawn(command, argv, opts)
  }

  const id = ++nextId
  const stdio = hostStdio(opts)
  const child = new RemoteChildProcess(id, state, command, argv, stdio)
  state.children.set(id, child)

  const { stdio: _stdio, env, signal, ...rest } = opts

  const request: HostInbound = {
    t: 'spawn',
    id,
    file: command,
    args: argv,
    options: { ...rest, env: plainEnv(env), stdio }
  }

  if (signal) {
    if (signal.aborted) {
      queueMicrotask(() => child.kill(opts.killSignal))
    } else {
      signal.addEventListener('abort', () => child.kill(opts.killSignal), { once: true })
    }
  }

  try {
    state.transport.post(request)
  } catch (error) {
    // The channel is gone or the request cannot be cloned: start it here.
    state.children.delete(id)
    hostLog(
      `[spawn-host] request failed (${(error as Error)?.message || error}); spawning ${command} in the main process`
    )

    return nodeSpawn(command, argv, opts)
  }

  return child as unknown as ChildProcess
}

// node's execFile error: an Error carrying code, killed, signal, cmd, stdout and stderr.
type ExecFileError = Error & Record<string, any>
type ExecFileCallback = (error: ExecFileError | null, stdout: any, stderr: any) => void
type ExecFileOpts = Omit<ExecFileOptions, 'encoding'> & { encoding?: BufferEncoding | 'buffer' | null }

function execFileImpl(
  file: string,
  args?: readonly string[] | ExecFileOpts | ExecFileCallback | null,
  options?: ExecFileOpts | ExecFileCallback | null,
  callback?: ExecFileCallback
): ChildProcess {
  if (typeof args === 'function') {
    callback = args
    args = []
    options = {}
  } else if (!Array.isArray(args)) {
    callback = options as ExecFileCallback | undefined
    options = args as ExecFileOpts | null
    args = []
  }

  if (typeof options === 'function') {
    callback = options
    options = {}
  }

  const argv = [...(args as readonly string[])]
  const opts = (options ?? {}) as ExecFileOpts

  if (!host) {
    return nodeExecFile(file, argv, opts as ExecFileOptions, callback as any) as ChildProcess
  }

  const encoding = opts.encoding === undefined ? 'utf8' : opts.encoding
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024
  const timeout = opts.timeout ?? 0
  const killSignal = opts.killSignal ?? 'SIGTERM'
  const { timeout: _timeout, maxBuffer: _maxBuffer, encoding: _encoding, ...spawnOptions } = opts
  const child = spawnImpl(file, argv, { ...spawnOptions, stdio: 'pipe' } as SpawnOptions)
  const out: Buffer[] = []
  const err: Buffer[] = []
  let outLength = 0
  let errLength = 0
  let failure: ExecFileError | null = null
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const text = (chunks: Buffer[]) => {
    const all = Buffer.concat(chunks)

    return encoding && encoding !== 'buffer' ? all.toString(encoding) : all
  }

  const settle = (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) {
      return
    }

    settled = true
    clearTimeout(timer)
    const stdout = text(out)
    const stderr = text(err)
    const cmd = [file, ...argv].join(' ')

    if (!failure && code === 0 && signal === null) {
      callback?.(null, stdout, stderr)

      return
    }

    const error: ExecFileError =
      failure ??
      Object.assign(new Error(`Command failed: ${cmd}\n${String(stderr)}`), {
        code,
        killed: child.killed,
        signal
      })

    Object.assign(error, { cmd, stdout, stderr })
    callback?.(error, stdout, stderr)
  }

  const onData = (chunks: Buffer[], which: 'out' | 'err') => (data: Buffer) => {
    if (failure) {
      return
    }

    const length = which === 'out' ? (outLength += data.length) : (errLength += data.length)

    if (length > maxBuffer) {
      const room = data.length - (length - maxBuffer)
      chunks.push(data.subarray(0, Math.max(0, room)))
      failure = Object.assign(new RangeError(`${which === 'out' ? 'stdout' : 'stderr'} maxBuffer length exceeded`), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      })
      child.kill(killSignal)

      return
    }

    chunks.push(data)
  }

  child.stdout?.on('data', onData(out, 'out'))
  child.stderr?.on('data', onData(err, 'err'))
  child.on('error', error => {
    failure = error
    settle(null, null)
  })
  child.on('close', (code, signal) => settle(code, signal))

  if (timeout > 0) {
    timer = setTimeout(() => {
      child.kill(killSignal)
    }, timeout)
  }

  return child
}

/** child_process.spawn, with the process created in the spawn host when one runs. */
export const spawn = spawnImpl as unknown as typeof nodeSpawn

/**
 * child_process.execFile, with the process created in the spawn host when one
 * runs. Error shape, timeout, maxBuffer and encoding follow node, and so does
 * util.promisify (it resolves { stdout, stderr }).
 */
export const execFile = Object.assign(execFileImpl, {
  [promisify.custom]: (file: string, args?: readonly string[] | null, options?: ExecFileOpts | null) =>
    new Promise((resolve, reject) => {
      execFileImpl(file, args ?? [], options ?? {}, (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })
      )
    })
}) as unknown as typeof nodeExecFile
