function normalizeUri(uri: string): string {
  return uri.replace(/\/+$/, "");
}

export function isWorkspaceRepository(
  repositoryUri: string,
  workspaceFolderUris: readonly string[],
): boolean {
  const normalizedRepositoryUri = normalizeUri(repositoryUri);
  return workspaceFolderUris.some(
    (workspaceFolderUri) =>
      normalizeUri(workspaceFolderUri) === normalizedRepositoryUri,
  );
}
