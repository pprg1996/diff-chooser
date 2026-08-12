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
- Every Git repository opened as a workspace folder gets its own Diff Chooser
  provider. Repositories merely detected by VS Code, such as sibling worktrees,
  stay out of the Source Control view.

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

## Publishing

Version tags publish independently to both extension registries:

- [`azure-pipelines.yml`](azure-pipelines.yml) publishes to Visual Studio
  Marketplace for VS Code using Microsoft Entra workload identity.
- [`.github/workflows/publish.yml`](.github/workflows/publish.yml) publishes to
  Open VSX for Cursor using an Open VSX access token.

The tag must match the version in `package.json`. For example, version `0.1.0`
is published by pushing the `v0.1.0` tag. Both pipelines type-check, lint, and
test the extension before publishing.

### Visual Studio Marketplace

Create an Azure DevOps Azure Resource Manager service connection named
`diff-chooser-publishing` using workload identity federation. Its user-assigned
managed identity must be a Contributor on the `pprg1996` Visual Studio
Marketplace publisher. Then create an Azure Pipeline from the existing
`azure-pipelines.yml` file. No personal access token is stored.

See the official
[VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
for the managed identity, federated credential, service connection, and
Marketplace publisher setup.

### Open VSX

Sign the Open VSX Publisher Agreement, generate a dedicated CI access token,
and create the namespace once:

```sh
read -s OVSX_PAT
export OVSX_PAT
npx ovsx create-namespace pprg1996
unset OVSX_PAT
```

Store that token as the `OVSX_PAT` GitHub Actions secret. Open VSX does not
currently support OIDC trusted publishing, so this dedicated token remains
required. See the official
[Open VSX publishing guide](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions)
for account and namespace setup.
