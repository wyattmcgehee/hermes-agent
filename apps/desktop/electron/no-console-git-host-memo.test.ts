import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

import { HOST_REVALIDATE_MS, resetWindowsGitHost, windowsGitHost } from './no-console-git'

// Every git read asks for the no-console host. Resolving it walks the interpreter candidates with
// existsSync and re-reads the host script: synchronous file-system work on Electron's main thread,
// once per git spawn. A resolved host must be reused, and still re-resolve when its inputs change
// or after the revalidation window (a temp cleaner may have removed the script).
const savedPython = process.env.HERMES_DESKTOP_PYTHON

afterEach(() => {
  vi.restoreAllMocks()
  resetWindowsGitHost()

  if (savedPython === undefined) {
    delete process.env.HERMES_DESKTOP_PYTHON
  } else {
    process.env.HERMES_DESKTOP_PYTHON = savedPython
  }
})

function fakePython(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-console-host-'))
  const python = path.join(dir, 'python.exe')
  fs.writeFileSync(python, '')

  return python
}

test('a resolved host is reused without touching the file system again', () => {
  process.env.HERMES_DESKTOP_PYTHON = fakePython()
  let clock = 1_000
  const first = windowsGitHost(true, () => clock)

  expect(first?.pythonBin).toBe(process.env.HERMES_DESKTOP_PYTHON)
  const exists = vi.spyOn(fs, 'existsSync')
  const read = vi.spyOn(fs, 'readFileSync')

  for (let i = 0; i < 20; i++) {
    clock += 100
    expect(windowsGitHost(true, () => clock)).toBe(first)
  }

  expect(exists).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

test('the host re-resolves after the revalidation window and when its inputs change', () => {
  process.env.HERMES_DESKTOP_PYTHON = fakePython()
  let clock = 1_000
  const first = windowsGitHost(true, () => clock)
  const read = vi.spyOn(fs, 'readFileSync')

  clock += HOST_REVALIDATE_MS
  expect(windowsGitHost(true, () => clock)).not.toBe(first)
  expect(read).toHaveBeenCalled()

  const other = fakePython()
  process.env.HERMES_DESKTOP_PYTHON = other
  expect(windowsGitHost(true, () => clock)?.pythonBin).toBe(other)
})
