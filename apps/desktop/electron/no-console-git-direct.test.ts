import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { gitHostEnabled, hiddenGitSpawnSpec, simpleGitBinary, windowsGitHost } from './no-console-git'

// Every Windows git call goes through a Python host (venv python.exe -> interpreter -> git), two
// synchronous process starts on Electron's main thread per call (#151348). Electron's spawn already
// gives a console child CREATE_NO_WINDOW when no stdio is inherited, so git can be spawned directly
// with every stdio piped or ignored. That is an opt-in (HERMES_DESKTOP_DIRECT_GIT=1): the host stays
// the default until a packaged build has been shown not to flash a console.
const SWITCH = 'HERMES_DESKTOP_DIRECT_GIT'
let saved: string | undefined

beforeEach(() => {
  saved = process.env[SWITCH]
  delete process.env[SWITCH]
})

afterEach(() => {
  vi.unstubAllEnvs()

  if (saved === undefined) {
    delete process.env[SWITCH]
  } else {
    process.env[SWITCH] = saved
  }
})

// These tests only plan the spawn: no process is started, the interpreter is an empty file.
function resolvablePython(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-console-direct-'))
  const python = path.join(dir, 'python.exe')
  fs.writeFileSync(python, '')
  vi.stubEnv('HERMES_DESKTOP_PYTHON', python)

  return python
}

const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe'

test('with the switch unset, windows git goes through the Python host', () => {
  const python = resolvablePython()
  const spec = hiddenGitSpawnSpec(GIT, ['status'], { isWindows: true })

  expect(gitHostEnabled({})).toBe(true)
  expect(spec.command).toBe(python)
  expect(spec.args.slice(1)).toEqual(['status'])
  expect(simpleGitBinary(GIT, windowsGitHost(true))).toEqual([python, spec.args[0]])
})

test('HERMES_DESKTOP_DIRECT_GIT=1 spawns git directly, hidden, with no inherited stdio, even when a python is resolvable', () => {
  resolvablePython()
  vi.stubEnv(SWITCH, '1')

  const spec = hiddenGitSpawnSpec(GIT, ['worktree', 'list', '--porcelain'], { isWindows: true })

  expect(windowsGitHost(true)).toBeNull()
  expect(spec.command).toBe(GIT)
  expect(spec.args).toEqual(['worktree', 'list', '--porcelain'])
  expect(spec.options.windowsHide).toBe(true)
  expect(spec.options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
  expect(simpleGitBinary(GIT, windowsGitHost(true))).toBe(GIT)
})

test('the switch is read per call and only the exact value counts', () => {
  expect(gitHostEnabled({ [SWITCH]: '1' })).toBe(false)
  expect(gitHostEnabled({ [SWITCH]: '0' })).toBe(true)
  expect(gitHostEnabled({ [SWITCH]: 'true' })).toBe(true)
  expect(gitHostEnabled({ [SWITCH]: '' })).toBe(true)
})
