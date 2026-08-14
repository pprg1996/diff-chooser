import * as vscode from "vscode";
import {
  type BaselineSelection,
  type GitRef,
  listBranches,
  resolveCommit,
} from "./git";
import type { GitExtension } from "./git-api";
import {
  BaselineContentProvider,
  RepositoryComparison,
  RepositoryComparisons,
  registerBaselineContentProvider,
} from "./repository-comparison";

interface BaselineQuickPickItem extends vscode.QuickPickItem {
  branch?: GitRef;
  enterCommit?: true;
}

type ScmContext =
  | vscode.SourceControl
  | vscode.SourceControlResourceGroup
  | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const output = vscode.window.createOutputChannel("Diff Chooser", {
    log: true,
  });
  const contentProvider = new BaselineContentProvider();

  context.subscriptions.push(
    output,
    contentProvider,
    registerBaselineContentProvider(contentProvider),
    vscode.commands.registerCommand(
      "diffChooser.openDiff",
      async (
        originalUri: vscode.Uri,
        workingUri: vscode.Uri,
        title: string,
      ) => {
        await vscode.commands.executeCommand(
          "vscode.diff",
          originalUri,
          workingUri,
          title,
        );
      },
    ),
  );

  const gitExtension =
    vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!gitExtension) {
    void vscode.window.showErrorMessage(
      "Diff Chooser requires VS Code's built-in Git extension.",
    );
    return;
  }

  const git = gitExtension.isActive
    ? gitExtension.exports
    : await gitExtension.activate();
  if (!git.enabled) {
    void vscode.window.showErrorMessage(
      "Diff Chooser requires the built-in Git extension to be enabled.",
    );
    return;
  }

  const gitApi = git.getAPI(1);
  const comparisons = new RepositoryComparisons(
    context,
    contentProvider,
    output,
  );
  for (const repository of gitApi.repositories) {
    comparisons.add(repository);
  }
  context.subscriptions.push(
    comparisons,
    gitApi.onDidOpenRepository((repository) => comparisons.add(repository)),
    gitApi.onDidCloseRepository((repository) =>
      comparisons.remove(repository),
    ),
  );

  const chooseComparison = async (
    scmContext?: ScmContext,
  ): Promise<RepositoryComparison | undefined> => {
    const directMatch = comparisons.findForContext(scmContext);
    if (directMatch) {
      return directMatch;
    }

    const available = comparisons.available;
    if (available.length === 0) {
      void vscode.window.showInformationMessage(
        "Diff Chooser did not find an open Git repository.",
      );
      return undefined;
    }
    if (available.length === 1) {
      return available[0];
    }

    const selected = await vscode.window.showQuickPick(
      available.map((comparison) => ({
        label: `$(git-branch) ${comparison.displayName}`,
        description: comparison.selectedBaseline
          ? `${comparison.repositoryPath} · vs ${comparison.selectedBaseline.label}`
          : `${comparison.repositoryPath} · No baseline`,
        comparison,
      })),
      {
        placeHolder: "Select a worktree",
        matchOnDescription: true,
      },
    );
    return selected?.comparison;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "diffChooser.selectBaseline",
      async (scmContext?: ScmContext) => {
        const comparison = await chooseComparison(scmContext);
        if (!comparison) {
          return;
        }

        try {
          const branches = await listBranches(
            comparison.repository.rootUri.fsPath,
          );
          const items: BaselineQuickPickItem[] = [
            {
              label: "$(git-commit) Enter a commit or revision…",
              description: "Use its exact commit",
              enterCommit: true,
            },
            ...branches.map((branch) => ({
              label: `$(git-branch) ${branch.displayName}`,
              description:
                branch.kind === "local"
                  ? "Local branch · use merge base"
                  : "Remote branch · use merge base",
              branch,
            })),
          ];
          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: `Choose the baseline for ${comparison.displayName}`,
            matchOnDescription: true,
          });
          if (!picked) {
            return;
          }

          let selection: BaselineSelection;
          if (picked.branch) {
            selection = {
              kind: "branch",
              ref: picked.branch.fullName,
              label: picked.branch.displayName,
            };
          } else {
            const enteredRef = await vscode.window.showInputBox({
              title: "Select an exact commit baseline",
              prompt: "Enter a commit hash or Git revision",
              placeHolder: "For example: HEAD~3 or a1b2c3d",
              ignoreFocusOut: true,
            });
            if (!enteredRef) {
              return;
            }
            const commit = await resolveCommit(
              comparison.repository.rootUri.fsPath,
              enteredRef.trim(),
            );
            selection = {
              kind: "commit",
              ref: commit,
              label: commit.slice(0, 12),
            };
          }

          await comparison.setSelection(selection);
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Could not select baseline: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "diffChooser.clearBaseline",
      async (scmContext?: ScmContext) => {
        const comparison = await chooseComparison(scmContext);
        if (comparison) {
          await comparison.clearSelection();
        }
      },
    ),
    vscode.commands.registerCommand(
      "diffChooser.refresh",
      async (scmContext?: ScmContext) => {
        try {
          if (scmContext === comparisons.sourceControl) {
            await comparisons.refreshAll();
            return;
          }

          const comparison = await chooseComparison(scmContext);
          if (comparison) {
            await comparison.refresh();
          }
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Could not refresh Diff Chooser: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    ),
  );
}

export function deactivate(): void {}
