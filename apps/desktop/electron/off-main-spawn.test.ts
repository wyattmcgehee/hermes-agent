import { ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { execGit } from './no-console-git'
import { execFile, spawn, spawnHostActive, startSpawnHost, stopSpawnHost, workerTransport } from './off-main-spawn'
import { holdSpawnCalls } from './spawn-host.test-helpers'

const HOST = new URL('./spawn-host.ts', import.meta.url)
const SLOW_HOST = new URL('./spawn-host.test-helpers.ts', import.meta.url)
const NODE = process.execPath

/** The longest gap between 5 ms ticks on this thread while `work` runs. */
async function longestStall<T>(work: () => Promise<T>): Promise<{ value: T; stallMs: number }> {
  let last = performance.now()
  let stallMs = 0

  const timer = setInterval(() => {
    const now = performance.now()
    stallMs = Math.max(stallMs, now - last)
    last = now
  }, 5)

  try {
    const value = await work()
    stallMs = Math.max(stallMs, performance.now() - last)

    return { value, stallMs }
  } finally {
    clearInterval(timer)
  }
}

function run(command: string, args: string[], options: Parameters<typeof spawn>[2] = {}) {
  return new Promise<{ code: number | null; signal: string | null; out: string; err: string; child: ChildProcess }>(
    (resolve, reject) => {
      const child = spawn(command, args, options)
      let out = ''
      let err = ''
      child.stdout?.on('data', chunk => (out += String(chunk)))
      child.stderr?.on('data', chunk => (err += String(chunk)))
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal, out, err, child }))
    }
  )
}

afterEach(() => stopSpawnHost())

describe('off-main spawn: a slow process creation holds the spawn host, not the caller', () => {
  const HOLD_MS = 800

  it('execGit leaves the calling thread free while the OS takes long to create git', async () => {
    // The same model everywhere: whichever thread creates a process is held HOLD_MS.
    const undo = holdSpawnCalls(HOLD_MS)
    startSpawnHost(() => workerTransport(SLOW_HOST, { holdMs: HOLD_MS }))

    try {
      const t0 = performance.now()
      const { value, stallMs } = await longestStall(() => execGit('git', ['--version']))

      expect(value.code).toBe(0)
      expect(value.stdout).toMatch(/git version/)
      // The hold was paid (in the host) ...
      expect(performance.now() - t0).toBeGreaterThanOrEqual(HOLD_MS)
      // ... and not on this thread, which plays Electron's UI thread.
      expect(stallMs).toBeLessThan(HOLD_MS / 2)
    } finally {
      undo()
    }
  })

  it('execFile and spawn callers keep ticking through several slow starts at once', async () => {
    const undo = holdSpawnCalls(HOLD_MS)
    startSpawnHost(() => workerTransport(SLOW_HOST, { holdMs: HOLD_MS }))

    try {
      const { value, stallMs } = await longestStall(() =>
        Promise.all([
          promisify(execFile)(NODE, ['-e', 'process.stdout.write("a")']),
          run(NODE, ['-e', 'process.stdout.write("b")']),
          promisify(execFile)(NODE, ['-e', 'process.stdout.write("c")'])
        ])
      )

      expect(value.map(v => ('out' in v ? v.out : v.stdout))).toEqual(['a', 'b', 'c'])
      expect(stallMs).toBeLessThan(HOLD_MS / 2)
    } finally {
      undo()
    }
  })
})

describe('off-main spawn: the proxy behaves like a node ChildProcess', () => {
  it('is plain node:child_process until a host is started', () => {
    expect(spawnHostActive()).toBe(false)
    const child = spawn(NODE, ['-e', ''], { stdio: 'ignore' })
    expect(child).toBeInstanceOf(ChildProcess)
  })

  it('streams stdout and stderr, reports pid, the spawn event and the exit code', async () => {
    startSpawnHost(() => workerTransport(HOST))
    expect(spawnHostActive()).toBe(true)
    const result = await run(NODE, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'])

    expect(result).toMatchObject({ code: 3, signal: null, out: 'out', err: 'err' })
    expect(result.child).not.toBeInstanceOf(ChildProcess)
    expect(typeof result.child.pid).toBe('number')
    expect(result.child.exitCode).toBe(3)
  })

  it('carries stdin to the child, in order, before and after the start completes', async () => {
    startSpawnHost(() => workerTransport(HOST))
    const child = spawn(NODE, ['-e', 'process.stdin.pipe(process.stdout)'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => (out += chunk))
    child.stdin.write('one\n')
    await new Promise(resolve => child.once('spawn', resolve))
    child.stdin.write('two\n')
    child.stdin.end()
    const code = await new Promise(resolve => child.once('close', resolve))

    expect(code).toBe(0)
    expect(out).toBe('one\ntwo\n')
    expect(stderrIsNull(child)).toBe(true)
  })

  it('reports a missing program as an error event with code ENOENT', async () => {
    startSpawnHost(() => workerTransport(HOST))
    const child = spawn('hermes-no-such-program', [])
    const error = await new Promise<NodeJS.ErrnoException>(resolve => child.once('error', resolve))

    expect(error.code).toBe('ENOENT')
    expect(child.pid).toBeUndefined()
  })

  it('kills on request and reports killed', async () => {
    startSpawnHost(() => workerTransport(HOST))
    const child = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await new Promise(resolve => child.once('spawn', resolve))
    expect(child.kill()).toBe(true)

    const [code, signal] = await new Promise<[number | null, string | null]>(resolve =>
      child.once('close', (c, s) => resolve([c, s]))
    )

    expect(child.killed).toBe(true)
    expect(code !== 0 || signal !== null).toBe(true)
  })

  it('execFile matches node: callback values, exit-code errors, timeout and maxBuffer', async () => {
    startSpawnHost(() => workerTransport(HOST))

    const exec = (args: string[], options = {}) =>
      new Promise<{ error: any; stdout: any; stderr: any }>(resolve =>
        execFile(NODE, args, options, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
      )

    const ok = await exec(['-e', 'process.stdout.write("hi")'])
    expect(ok).toEqual({ error: null, stdout: 'hi', stderr: '' })

    const failed = await exec(['-e', 'process.stderr.write("bad"); process.exit(2)'])
    expect(failed.error).toMatchObject({ code: 2, killed: false, stderr: 'bad' })
    expect(failed.error.message).toMatch(/^Command failed: /)

    const timedOut = await exec(['-e', 'setInterval(() => {}, 1000)'], { timeout: 200 })
    expect(timedOut.error).toMatchObject({ killed: true, code: null })

    const big = await exec(['-e', 'process.stdout.write("x".repeat(5000))'], { maxBuffer: 100 })
    expect(big.error.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    expect(big.stdout).toBe('x'.repeat(100))

    const buffers = await exec(['-e', 'process.stdout.write("b")'], { encoding: 'buffer' })
    expect(Buffer.isBuffer(buffers.stdout)).toBe(true)

    await expect(promisify(execFile)(NODE, ['-e', 'process.stdout.write("p")'])).resolves.toEqual({
      stdout: 'p',
      stderr: ''
    })
  })

  it('fails in-flight children when the host dies and starts a new host for the next spawn', async () => {
    let starts = 0
    let current: ReturnType<typeof workerTransport> | null = null
    startSpawnHost(() => {
      starts++
      current = workerTransport(HOST)

      return current
    })
    const child = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await new Promise(resolve => child.once('spawn', resolve))
    const pid = child.pid
    const lost = new Promise<NodeJS.ErrnoException>(resolve => child.once('error', resolve))
    current!.kill()

    expect((await lost).code).toBe('ESPAWNHOST')
    await new Promise(resolve => child.once('close', resolve))
    expect(starts).toBe(2)
    expect((await run(NODE, ['-e', 'process.stdout.write("again")'])).out).toBe('again')

    // The orphan the dead host left behind is still ours to stop.
    try {
      process.kill(pid!)
    } catch {
      // Already gone.
    }
  })
})

function stderrIsNull(child: ChildProcess): boolean {
  return child.stderr === null
}
