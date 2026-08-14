import * as path from "node:path";
import * as vscode from "vscode";
import type { GitRepository } from "./git-api";
import {
  type BaselineSelection,
  type GitChange,
  getChanges,
  readBaselineFile,
  resolveBaseline,
} from "./git";
import {
  formatWorktreeGroupLabel,
  formatWorktreeName,
} from "./repository-label";

const virtualDocumentScheme = "diff-chooser";

interface VirtualDocumentData {
  repositoryRoot: string;
  baselineCommit: string;
  path: string;
  empty?: true;
}

function createVirtualUri(data: VirtualDocumentData): vscode.Uri {
  return vscode.Uri.from({
    scheme: virtualDocumentScheme,
    path: `/${data.path}`,
    query: Buffer.from(JSON.stringify(data)).toString("base64url"),
  });
}

function parseVirtualUri(uri: vscode.Uri): VirtualDocumentData {
  return JSON.parse(
    Buffer.from(uri.query, "base64url").toString("utf8"),
  ) as VirtualDocumentData;
}

export class BaselineContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly servedUris = new Map<string, Map<string, vscode.Uri>>();

  readonly onDidChange = this.changeEmitter.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const data = parseVirtualUri(uri);
    let repositoryUris = this.servedUris.get(data.repositoryRoot);
    if (!repositoryUris) {
      repositoryUris = new Map();
      this.servedUris.set(data.repositoryRoot, repositoryUris);
    }
    repositoryUris.set(uri.toString(), uri);

    if (data.empty) {
      return "";
    }

    return (
      (await readBaselineFile(
        data.repositoryRoot,
        data.baselineCommit,
        data.path,
      )) ?? ""
    );
  }

  invalidateRepository(repositoryRoot: string): void {
    const repositoryUris = this.servedUris.get(repositoryRoot);
    if (!repositoryUris) {
      return;
    }
    for (const uri of repositoryUris.values()) {
      this.changeEmitter.fire(uri);
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.servedUris.clear();
  }
}

export class RepositoryComparison implements vscode.Disposable {
  readonly resourceGroup: vscode.SourceControlResourceGroup;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly persistenceKey: string;
  private selection: BaselineSelection | undefined;
  private baselineCommit: string | undefined;
  private renamedPaths = new Map<string, string>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshGeneration = 0;

  constructor(
    readonly repository: GitRepository,
    sourceControl: vscode.SourceControl,
    private readonly context: vscode.ExtensionContext,
    private readonly contentProvider: BaselineContentProvider,
    private readonly output: vscode.OutputChannel,
    private readonly invalidateQuickDiff: () => void,
  ) {
    this.persistenceKey = `diffChooser.baseline.${repository.rootUri.toString()}`;
    this.selection =
      context.workspaceState.get<BaselineSelection>(this.persistenceKey);

    this.resourceGroup = sourceControl.createResourceGroup(
      `worktree:${Buffer.from(repository.rootUri.toString()).toString("base64url")}`,
      this.groupLabel,
    );
    this.resourceGroup.hideWhenEmpty = false;

    this.disposables.push(
      repository.state.onDidChange(() => {
        this.resourceGroup.label = this.groupLabel;
        this.scheduleRefresh();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.contains(document.uri)) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidCreateFiles((event) => {
        if (event.files.some((uri) => this.contains(uri))) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        if (event.files.some((uri) => this.contains(uri))) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        if (
          event.files.some(
            ({ oldUri, newUri }) =>
              this.contains(oldUri) || this.contains(newUri),
          )
        ) {
          this.scheduleRefresh();
        }
      }),
    );
  }

  get displayName(): string {
    return formatWorktreeName(
      this.repository.rootUri.fsPath,
      this.repository.state.HEAD,
    );
  }

  get selectedBaseline(): BaselineSelection | undefined {
    return this.selection;
  }

  get repositoryPath(): string {
    return this.repository.rootUri.fsPath;
  }

  private get groupLabel(): string {
    return formatWorktreeGroupLabel(
      this.repository.rootUri.fsPath,
      this.repository.state.HEAD,
      this.selection,
    );
  }

  async initialize(): Promise<void> {
    await this.refresh();
  }

  async setSelection(selection: BaselineSelection): Promise<void> {
    this.selection = selection;
    this.resourceGroup.label = this.groupLabel;
    await this.context.workspaceState.update(this.persistenceKey, selection);
    await this.refresh();
  }

  async clearSelection(): Promise<void> {
    this.selection = undefined;
    this.resourceGroup.label = this.groupLabel;
    await this.context.workspaceState.update(this.persistenceKey, undefined);
    await this.refresh();
  }

  scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch((error: unknown) => {
        this.output.appendLine(
          `[${this.displayName}] ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, 150);
  }

  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const selection = this.selection;

    if (!selection) {
      const baselineChanged = this.baselineCommit !== undefined;
      this.baselineCommit = undefined;
      this.renamedPaths.clear();
      this.resourceGroup.label = this.groupLabel;
      this.resourceGroup.resourceStates = [];
      this.contentProvider.invalidateRepository(this.repository.rootUri.fsPath);
      if (baselineChanged) {
        this.invalidateQuickDiff();
      }
      return;
    }

    const baselineCommit = await resolveBaseline(
      this.repository.rootUri.fsPath,
      selection,
    );
    const changes = await getChanges(
      this.repository.rootUri.fsPath,
      baselineCommit,
    );

    if (generation !== this.refreshGeneration) {
      return;
    }

    const baselineChanged = baselineCommit !== this.baselineCommit;
    this.baselineCommit = baselineCommit;
    this.renamedPaths = new Map(
      changes
        .filter(
          (
            change,
          ): change is GitChange & {
            originalPath: string;
          } => change.kind === "renamed" && change.originalPath !== undefined,
        )
        .map((change) => [change.path, change.originalPath]),
    );

    this.resourceGroup.label = this.groupLabel;
    this.resourceGroup.resourceStates = changes.map((change) =>
      this.createResourceState(change, baselineCommit),
    );

    if (baselineChanged) {
      this.contentProvider.invalidateRepository(
        this.repository.rootUri.fsPath,
      );
      this.invalidateQuickDiff();
    }
  }

  private createResourceState(
    change: GitChange,
    baselineCommit: string,
  ): vscode.SourceControlResourceState {
    const workingUri = vscode.Uri.file(
      path.join(this.repository.rootUri.fsPath, change.path),
    );
    const originalPath = change.originalPath ?? change.path;
    const baselineUri = createVirtualUri({
      repositoryRoot: this.repository.rootUri.fsPath,
      baselineCommit,
      path: originalPath,
    });
    const rightUri =
      change.kind === "deleted"
        ? createVirtualUri({
            repositoryRoot: this.repository.rootUri.fsPath,
            baselineCommit,
            path: change.path,
            empty: true,
          })
        : workingUri;
    const title =
      change.kind === "renamed"
        ? `${change.originalPath} → ${change.path} (${this.selection?.label})`
        : `${change.path} (${this.selection?.label})`;

    return {
      resourceUri: workingUri,
      command: {
        command: "diffChooser.openDiff",
        title: "Open Comparison",
        arguments: [baselineUri, rightUri, title],
      },
      decorations: {
        strikeThrough: change.kind === "deleted",
        tooltip: {
          modified: "Modified against baseline",
          added: "Added against baseline",
          deleted: "Deleted against baseline",
          renamed: `Renamed from ${change.originalPath}`,
        }[change.kind],
        iconPath: new vscode.ThemeIcon(
          {
            modified: "diff-modified",
            added: "diff-added",
            deleted: "diff-removed",
            renamed: "diff-renamed",
          }[change.kind],
        ),
      },
    };
  }

  provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (!this.baselineCommit || !this.contains(uri)) {
      return undefined;
    }

    const relativePath = path
      .relative(this.repository.rootUri.fsPath, uri.fsPath)
      .split(path.sep)
      .join("/");
    return createVirtualUri({
      repositoryRoot: this.repository.rootUri.fsPath,
      baselineCommit: this.baselineCommit,
      path: this.renamedPaths.get(relativePath) ?? relativePath,
    });
  }

  contains(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file") {
      return false;
    }
    const relativePath = path.relative(
      this.repository.rootUri.fsPath,
      uri.fsPath,
    );
    return (
      relativePath === "" ||
      (!relativePath.startsWith(`..${path.sep}`) &&
        relativePath !== ".." &&
        !path.isAbsolute(relativePath))
    );
  }

  dispose(): void {
    ++this.refreshGeneration;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.resourceGroup.dispose();
  }
}

export class RepositoryComparisons implements vscode.Disposable {
  readonly sourceControl: vscode.SourceControl;

  private readonly comparisons = new Map<string, RepositoryComparison>();
  private readonly quickDiffProvider: vscode.QuickDiffProvider;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly contentProvider: BaselineContentProvider,
    private readonly output: vscode.OutputChannel,
  ) {
    this.sourceControl = vscode.scm.createSourceControl(
      "diffChooser",
      vscode.workspace.name
        ? `${vscode.workspace.name} Diff Chooser`
        : "Diff Chooser",
    );
    this.sourceControl.inputBox.visible = false;
    // Baseline comparisons are contextual, not pending Git changes. Keep them
    // out of VS Code's aggregated Source Control activity badge.
    this.sourceControl.count = 0;

    this.quickDiffProvider = {
      provideOriginalResource: (uri) => this.provideOriginalResource(uri),
    };
    this.sourceControl.quickDiffProvider = this.quickDiffProvider;
  }

  get available(): RepositoryComparison[] {
    return [...this.comparisons.values()].sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.repositoryPath.localeCompare(right.repositoryPath),
    );
  }

  add(repository: GitRepository): void {
    const key = repository.rootUri.toString();
    if (this.comparisons.has(key)) {
      return;
    }

    const comparison = new RepositoryComparison(
      repository,
      this.sourceControl,
      this.context,
      this.contentProvider,
      this.output,
      () => this.invalidateQuickDiff(),
    );
    this.comparisons.set(key, comparison);
    void comparison.initialize().catch((error: unknown) => {
      this.output.appendLine(
        `[${comparison.displayName}] ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  remove(repository: GitRepository): void {
    const key = repository.rootUri.toString();
    this.comparisons.get(key)?.dispose();
    this.comparisons.delete(key);
  }

  findForContext(
    context?: vscode.SourceControl | vscode.SourceControlResourceGroup,
  ): RepositoryComparison | undefined {
    return this.available.find(
      (comparison) => comparison.resourceGroup === context,
    );
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.available.map((comparison) => comparison.refresh()));
  }

  private provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    return this.available
      .filter((comparison) => comparison.contains(uri))
      .sort(
        (left, right) =>
          right.repositoryPath.length - left.repositoryPath.length,
      )[0]
      ?.provideOriginalResource(uri);
  }

  private invalidateQuickDiff(): void {
    this.sourceControl.quickDiffProvider = undefined;
    this.sourceControl.quickDiffProvider = this.quickDiffProvider;
  }

  dispose(): void {
    for (const comparison of this.comparisons.values()) {
      comparison.dispose();
    }
    this.comparisons.clear();
    this.sourceControl.dispose();
  }
}

export function registerBaselineContentProvider(
  provider: BaselineContentProvider,
): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(
    virtualDocumentScheme,
    provider,
  );
}
