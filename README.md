# Diff Chooser

Diff Chooser is a VS Code and Cursor extension that keeps an entire feature
branch visible after work-in-progress commits. It adds a separate Source
Control provider whose file list and editor gutter compare against a branch or
commit you choose.

The built-in Git provider is not modified. Its normal working-tree changes can
remain visible alongside Diff Chooser.

## How comparisons work

- Selecting a local or remote branch compares against the merge base between
  that branch and the current `HEAD`. This shows work added on the current
  branch without showing newer commits that only exist on the selected branch.
- Entering a commit hash or Git revision resolves it once and uses that exact
  commit.
- Committed, staged, unstaged, and untracked changes are included.
- The selection is stored per repository in workspace state.
- Every Git repository detected by VS Code gets its own Diff Chooser provider.

For example, if a feature branch split from `main` at commit `A`, then `main`
added `M1` and the feature branch added `F1`, selecting `main` uses `A` as the
baseline. The resulting comparison shows `F1`, not the absence of `M1`.

## Commands

The following commands are available from the Command Palette and from each
Diff Chooser provider's title bar:

- **Diff Chooser: Select Baseline** lists local and remote branches and allows
  entering an exact commit or revision.
- **Diff Chooser: Refresh** recalculates the selected baseline and changed
  files.
- **Diff Chooser: Clear Baseline** removes the saved selection for that
  repository.

Click a changed file in the Diff Chooser provider to open its full comparison.
Editor gutter markers use the same baseline while you edit. Rename comparisons
use the file's original path.

## Requirements and limitations

- VS Code API version 1.125 or a compatible Cursor release.
- The `git` executable must be available on `PATH`.
- Diff Chooser appears as an additional Source Control provider because the
  public extension API cannot replace the built-in Git provider's baseline.
- Built-in Git gutter markers may coexist with Diff Chooser markers.
- Deleted files appear in Source Control and open as a comparison, but cannot
  display gutter markers because there is no working file to open.
- Quick diffs are text documents; binary files do not have meaningful gutter
  comparisons.

## Development

```sh
npm install
npm run check
npm run lint
npm test
```

Use the **Run Diff Chooser** launch configuration to open an Extension
Development Host when interactive testing is desired. Create a VSIX with:

```sh
npm run package
```
