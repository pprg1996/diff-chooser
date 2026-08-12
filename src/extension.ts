import * as vscode from "vscode";
import {
  type BaselineSelection,
  type GitRef,
  listBranches,
  resolveCommit,
} from "./git";
import type { GitExtension, GitRepository } from "./git-api";
import {
  BaselineContentProvider,
  RepositoryComparison,
  registerBaselineContentProvider,
} from "./repository-comparison";
import { isWorkspaceRepository } from "./workspace-repositories";

interface BaselineQuickPickItem extends vscode.QuickPickItem {
  branch?: GitRef;
  enterCommit?: true;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const output = vscode.window.createOutputChannel("Diff Chooser", {
    log: true,
  });
  const contentProvider = new BaselineContentProvider();
  const comparisons = new Map<string, RepositoryComparison>();

  context.subscriptions.push(
    output,
    contentProvider,
    registerBaselineContentProvider(contentProvider),
    {
      dispose: () => {
        for (const comparison of comparisons.values()) {
          comparison.dispose();
        }
        comparisons.clear();
      },
    },
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
  const workspaceFolderUris = (): string[] =>
    (vscode.workspace.workspaceFolders ?? []).map(({ uri }) => uri.toString());

  const addRepository = (repository: GitRepository): void => {
    const key = repository.rootUri.toString();
    if (
      comparisons.has(key) ||
      !isWorkspaceRepository(key, workspaceFolderUris())
    ) {
      return;
    }

    const comparison = new RepositoryComparison(
      repository,
      context,
      contentProvider,
      output,
    );
    comparisons.set(key, comparison);
    void comparison.initialize().catch((error: unknown) => {
      output.appendLine(
        `[${comparison.displayName}] ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const removeRepository = (repository: GitRepository): void => {
    const key = repository.rootUri.toString();
    comparisons.get(key)?.dispose();
    comparisons.delete(key);
  };

  const syncWorkspaceRepositories = (): void => {
    const openWorkspaceFolderUris = workspaceFolderUris();
    for (const [key, comparison] of comparisons) {
      if (!isWorkspaceRepository(key, openWorkspaceFolderUris)) {
        comparison.dispose();
        comparisons.delete(key);
      }
    }
    for (const repository of gitApi.repositories) {
      addRepository(repository);
    }
  };

  syncWorkspaceRepositories();
  context.subscriptions.push(
    gitApi.onDidOpenRepository(addRepository),
    gitApi.onDidCloseRepository(removeRepository),
    vscode.workspace.onDidChangeWorkspaceFolders(syncWorkspaceRepositories),
  );

  const chooseComparison = async (
    sourceControl?: vscode.SourceControl,
  ): Promise<RepositoryComparison | undefined> => {
    const directMatch = [...comparisons.values()].find(
      (comparison) => comparison.sourceControl === sourceControl,
    );
    if (directMatch) {
      return directMatch;
    }

    const available = [...comparisons.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
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
        label: comparison.displayName,
        description: comparison.selectedBaseline?.label ?? "No baseline",
        comparison,
      })),
      {
        placeHolder: "Select a Git repository",
      },
    );
    return selected?.comparison;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "diffChooser.selectBaseline",
      async (sourceControl?: vscode.SourceControl) => {
        const comparison = await chooseComparison(sourceControl);
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
      async (sourceControl?: vscode.SourceControl) => {
        const comparison = await chooseComparison(sourceControl);
        if (comparison) {
          await comparison.clearSelection();
        }
      },
    ),
    vscode.commands.registerCommand(
      "diffChooser.refresh",
      async (sourceControl?: vscode.SourceControl) => {
        const comparison = await chooseComparison(sourceControl);
        if (!comparison) {
          return;
        }
        try {
          await comparison.refresh();
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
