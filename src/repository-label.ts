import * as path from "node:path";
import type { BaselineSelection } from "./git";
import type { GitBranch } from "./git-api";

export function formatWorktreeName(
  repositoryRoot: string,
  head?: GitBranch,
): string {
  return (
    head?.name ??
    (head?.commit
      ? `detached@${head.commit.slice(0, 7)}`
      : path.basename(repositoryRoot))
  );
}

export function formatWorktreeGroupLabel(
  repositoryRoot: string,
  head: GitBranch | undefined,
  selection: BaselineSelection | undefined,
): string {
  const worktreeName = formatWorktreeName(repositoryRoot, head);
  return selection
    ? `${worktreeName} → ${selection.label}`
    : `${worktreeName} → Select baseline`;
}
