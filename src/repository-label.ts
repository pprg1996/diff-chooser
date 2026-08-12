import * as path from "node:path";
import type { GitBranch } from "./git-api";

export function formatRepositoryLabel(
  repositoryRoot: string,
  head?: GitBranch,
): string {
  const repositoryName = path.basename(repositoryRoot);
  const branchName =
    head?.name ??
    (head?.commit ? `detached@${head.commit.slice(0, 7)}` : undefined);

  return branchName
    ? `Diff Chooser (${repositoryName} · ${branchName})`
    : `Diff Chooser (${repositoryName})`;
}
