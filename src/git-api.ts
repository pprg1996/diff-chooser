import type { Event, Uri } from "vscode";

export interface GitRepository {
  readonly rootUri: Uri;
  readonly state: {
    readonly onDidChange: Event<void>;
  };
}

export interface GitApi {
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: Event<GitRepository>;
  readonly onDidCloseRepository: Event<GitRepository>;
}

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}
