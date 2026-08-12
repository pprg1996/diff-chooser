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
import { formatRepositoryLabel } from "./repository-label";

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
  private currentSourceControl: vscode.SourceControl;

  private changesGroup: vscode.SourceControlResourceGroup;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly persistenceKey: string;
  private readonly quickDiffProvider: vscode.QuickDiffProvider;
  private selection: BaselineSelection | undefined;
  private baselineCommit: string | undefined;
  private renamedPaths = new Map<string, string>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshGeneration = 0;

  constructor(
    readonly repository: GitRepository,
    private readonly context: vscode.ExtensionContext,
    private readonly contentProvider: BaselineContentProvider,
    private readonly output: vscode.OutputChannel,
  ) {
    this.persistenceKey = `diffChooser.baseline.${repository.rootUri.toString()}`;
    this.selection =
      context.workspaceState.get<BaselineSelection>(this.persistenceKey);

    this.quickDiffProvider = {
      provideOriginalResource: (uri) => this.provideOriginalResource(uri),
    };

    const { sourceControl, changesGroup } = this.createSourceControl();
    this.currentSourceControl = sourceControl;
    this.changesGroup = changesGroup;

    this.disposables.push(
      repository.state.onDidChange(() => {
        this.updateSourceControlLabel();
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

  get sourceControl(): vscode.SourceControl {
    return this.currentSourceControl;
  }

  get displayName(): string {
    return path.basename(this.repository.rootUri.fsPath);
  }

  get selectedBaseline(): BaselineSelection | undefined {
    return this.selection;
  }

  private createSourceControl(): {
    sourceControl: vscode.SourceControl;
    changesGroup: vscode.SourceControlResourceGroup;
  } {
    const sourceControl = vscode.scm.createSourceControl(
      "diffChooser",
      formatRepositoryLabel(
        this.repository.rootUri.fsPath,
        this.repository.state.HEAD,
      ),
      this.repository.rootUri,
    );
    sourceControl.inputBox.visible = false;
    sourceControl.quickDiffProvider = this.quickDiffProvider;

    const changesGroup = sourceControl.createResourceGroup(
      "changes",
      "Select baseline",
    );
    changesGroup.hideWhenEmpty = false;

    return { sourceControl, changesGroup };
  }

  private updateSourceControlLabel(): void {
    const label = formatRepositoryLabel(
      this.repository.rootUri.fsPath,
      this.repository.state.HEAD,
    );
    if (label === this.currentSourceControl.label) {
      return;
    }

    const previousSourceControl = this.currentSourceControl;
    const previousGroup = this.changesGroup;
    const previousGroupLabel = previousGroup.label;
    const previousResourceStates = previousGroup.resourceStates;
    const previousCount = previousSourceControl.count;

    const { sourceControl, changesGroup } = this.createSourceControl();
    changesGroup.label = previousGroupLabel;
    changesGroup.resourceStates = previousResourceStates;
    sourceControl.count = previousCount;

    this.currentSourceControl = sourceControl;
    this.changesGroup = changesGroup;
    previousSourceControl.dispose();
  }

  async initialize(): Promise<void> {
    await this.refresh();
  }

  async setSelection(selection: BaselineSelection): Promise<void> {
    this.selection = selection;
    await this.context.workspaceState.update(this.persistenceKey, selection);
    await this.refresh();
  }

  async clearSelection(): Promise<void> {
    this.selection = undefined;
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
      this.baselineCommit = undefined;
      this.renamedPaths.clear();
      this.changesGroup.label = "Select baseline";
      this.changesGroup.resourceStates = [];
      this.sourceControl.count = 0;
      this.contentProvider.invalidateRepository(this.repository.rootUri.fsPath);
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

    this.changesGroup.label =
      selection.kind === "branch"
        ? `Changes vs ${selection.label} (merge base)`
        : `Changes vs ${selection.label}`;
    this.changesGroup.resourceStates = changes.map((change) =>
      this.createResourceState(change, baselineCommit),
    );
    this.sourceControl.count = changes.length;

    if (baselineChanged) {
      this.contentProvider.invalidateRepository(
        this.repository.rootUri.fsPath,
      );
      this.sourceControl.quickDiffProvider = undefined;
      this.sourceControl.quickDiffProvider = this.quickDiffProvider;
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

  private provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
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

  private contains(uri: vscode.Uri): boolean {
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
    this.currentSourceControl.dispose();
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
