import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, test } from 'vitest'

import { defaultBranchName, gitFor } from './git-review-ops'

// The coding rail's status read names the repo's trunk. It probed origin/HEAD and then each candidate ref with its own
// git process, each a main-thread spawn and, on Windows, a Python host start. One git process must answer. (The per-ref
// probe also never saw a missing ref: `rev-parse --verify --quiet` fails with empty stderr, which simple-git resolves
// as success, so every repo without origin/HEAD was named `main`. These cases pin the intended precedence.)
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

function repo(branch: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-default-branch-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })

  tempDirs.push(dir)
  git('init', '-q', '-b', branch)
  git('config', 'user.email', 'hermes-test@example.com')
  git('config', 'user.name', 'Hermes Test')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  git('add', 'a.txt')
  git('commit', '-qm', 'initial')

  return dir
}

function counted(dir: string) {
  const git = gitFor(dir, 'git')
  const calls: string[][] = []
  const raw = git.raw.bind(git)
  const revparse = git.revparse.bind(git)

  return {
    calls,
    git: Object.assign(Object.create(git), {
      raw: (args: string[]) => (calls.push(args), raw(args)),
      revparse: (args: string[]) => (calls.push(args), revparse(args))
    })
  }
}

test('a repo with no origin and no trunk is answered by one git process', async () => {
  const { calls, git } = counted(repo('feature'))

  expect(await defaultBranchName(git)).toBeNull()
  expect(calls).toHaveLength(1)
})

test('local trunks are found in precedence order (main, then master), with one git process', async () => {
  const dir = repo('master')
  const { calls, git } = counted(dir)

  expect(await defaultBranchName(git)).toBe('master')
  execFileSync('git', ['branch', 'main'], { cwd: dir })
  expect(await defaultBranchName(git)).toBe('main')
  expect(calls).toHaveLength(2)
})

test("origin/HEAD's target wins, and remote-only trunks are named without the remote", async () => {
  const dir = repo('feature')
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()

  execFileSync('git', ['update-ref', 'refs/remotes/origin/master', sha], { cwd: dir })
  const { git } = counted(dir)

  expect(await defaultBranchName(git)).toBe('master')
  execFileSync('git', ['update-ref', 'refs/remotes/origin/develop', sha], { cwd: dir })
  execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop'], { cwd: dir })
  expect(await defaultBranchName(git)).toBe('develop')
})
