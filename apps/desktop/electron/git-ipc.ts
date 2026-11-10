// IPC surface for git-driven features: worktree management ("Start work"),
// the composer coding rail's repo status, the Codex-style review pane, and
// repo-first project discovery. Extracted from main.ts; the git/gh binary
// resolvers stay injected because main.ts also uses them for self-update and
// plugin installs.
import { ipcMain } from 'electron'

import { createGitReadCoalescer } from './git-read-coalescer'
import { scanGitRepos } from './git-repo-scan'
import {
  fileDiffVsHead,
  repoStatus,
  reviewCommit,
  reviewCommitContext,
  reviewCreatePr,
  reviewDiff,
  reviewList,
  reviewPrList,
  reviewPush,
  reviewRevert,
  reviewRevParse,
  reviewShipInfo,
  reviewStage,
  reviewUnstage
} from './git-review-ops'
import {
  addWorktree,
  listBaseBranches,
  listBranches,
  listWorktrees,
  removeWorktree,
  switchBranch
} from './git-worktree-ops'

export interface GitIpcDeps {
  resolveGitBinary: () => string
  resolveGhBinary: () => string
}

const noWorktrees = (trees: unknown) => !Array.isArray(trees) || trees.length === 0
const noStatus = (status: unknown) => status == null

export function registerGitIpc({ resolveGitBinary, resolveGhBinary }: GitIpcDeps) {
  // Panes and windows that re-read the same repo on the same edge share one git run (git-read-coalescer.ts).
  const reads = createGitReadCoalescer()

  const sharedRead = <T>(
    op: string,
    repoPath: unknown,
    gitBin: string,
    run: () => Promise<T>,
    isEmpty?: (value: T) => boolean
  ): Promise<T> =>
    reads.read(JSON.stringify([op, gitBin, typeof repoPath === 'string' ? repoPath : null]), run, isEmpty)

  // A desktop git mutation: later reads must see its effect, never join a run from before it.
  const mutation = <T>(run: () => Promise<T>): Promise<T> => {
    reads.invalidate()

    return run().finally(reads.invalidate)
  }

  // Git-driven worktree management ("Start work" flow). Errors surface to the
  // renderer as rejected promises so it can toast a friendly message.
  ipcMain.handle('hermes:git:worktreeList', async (_event, repoPath) => {
    const gitBin = resolveGitBinary()

    // No worktrees = not a repo (a repo always lists its main checkout): kept with backoff, see git-read-coalescer.ts.
    return sharedRead('worktreeList', repoPath, gitBin, () => listWorktrees(repoPath, gitBin), noWorktrees)
  })

  ipcMain.handle('hermes:git:worktreeAdd', async (_event, repoPath, options) =>
    mutation(() => addWorktree(repoPath, options || {}, resolveGitBinary()))
  )

  ipcMain.handle('hermes:git:worktreeRemove', async (_event, repoPath, worktreePath, options) =>
    mutation(() => removeWorktree(repoPath, worktreePath, options || {}, resolveGitBinary()))
  )

  ipcMain.handle('hermes:git:branchSwitch', async (_event, repoPath, branch) =>
    mutation(() => switchBranch(repoPath, branch, resolveGitBinary()))
  )

  ipcMain.handle('hermes:git:branchList', async (_event, repoPath) => listBranches(repoPath, resolveGitBinary()))

  ipcMain.handle('hermes:git:baseBranchList', async (_event, repoPath) =>
    listBaseBranches(repoPath, resolveGitBinary())
  )

  // Compact repo status (branch, ahead/behind, change counts + files) for the
  // composer coding rail. Returns null on a non-repo / remote backend so the rail
  // hides cleanly rather than erroring.
  ipcMain.handle('hermes:git:repoStatus', async (_event, repoPath) => {
    const gitBin = resolveGitBinary()

    return sharedRead('repoStatus', repoPath, gitBin, () => repoStatus(repoPath, gitBin), noStatus)
  })

  // Codex-style review pane: list changed files for a scope, fetch one file's
  // unified diff, and stage / unstage / revert. Reads return empty on failure;
  // mutations reject so the renderer can toast.
  ipcMain.handle('hermes:git:review:list', async (_event, repoPath, scope, baseRef) =>
    reviewList(repoPath, scope, baseRef, resolveGitBinary())
  )
  ipcMain.handle('hermes:git:review:diff', async (_event, repoPath, filePath, scope, baseRef, staged) =>
    reviewDiff(repoPath, filePath, scope, baseRef, staged, resolveGitBinary())
  )
  // Working-tree-vs-HEAD diff for one file (the preview's "show the diff" view).
  ipcMain.handle('hermes:git:fileDiff', async (_event, repoPath, filePath) =>
    fileDiffVsHead(repoPath, filePath, resolveGitBinary())
  )
  ipcMain.handle('hermes:git:review:stage', async (_event, repoPath, filePath) =>
    mutation(() => reviewStage(repoPath, filePath ?? null, resolveGitBinary()))
  )
  ipcMain.handle('hermes:git:review:unstage', async (_event, repoPath, filePath) =>
    mutation(() => reviewUnstage(repoPath, filePath ?? null, resolveGitBinary()))
  )
  ipcMain.handle('hermes:git:review:revert', async (_event, repoPath, filePath) =>
    mutation(() => reviewRevert(repoPath, filePath ?? null, resolveGitBinary()))
  )
  ipcMain.handle('hermes:git:review:revParse', async (_event, repoPath, ref) =>
    reviewRevParse(repoPath, ref, resolveGitBinary())
  )
  ipcMain.handle('hermes:git:review:commit', async (_event, repoPath, message, push) =>
    mutation(() => reviewCommit(repoPath, message, Boolean(push), resolveGitBinary()))
  )
  ipcMain.handle('hermes:git:review:commitContext', async (_event, repoPath) =>
    reviewCommitContext(repoPath, resolveGitBinary())
  )
  ipcMain.handle('hermes:git:review:push', async (_event, repoPath) =>
    mutation(() => reviewPush(repoPath, resolveGitBinary()))
  )
  ipcMain.handle('hermes:git:review:shipInfo', async (_event, repoPath) => reviewShipInfo(repoPath, resolveGhBinary()))
  ipcMain.handle('hermes:git:review:prList', async (_event, repoPath, branches, numbers) =>
    reviewPrList(repoPath, resolveGhBinary(), branches, numbers)
  )
  ipcMain.handle('hermes:git:review:createPr', async (_event, repoPath) =>
    mutation(() => reviewCreatePr(repoPath, resolveGitBinary(), resolveGhBinary()))
  )

  // Repo-first project discovery: scan bounded roots for git repos (pure fs walk,
  // no native addon). Never throws to the renderer — failures yield an empty list.
  ipcMain.handle('hermes:git:scanRepos', async (_event, roots, options) => {
    try {
      return await scanGitRepos(roots || [], options || {})
    } catch {
      return []
    }
  })
}
