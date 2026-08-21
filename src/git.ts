import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BaselineSelection =
  | { kind: "branch"; ref: string; label: string }
  | { kind: "commit"; ref: string; label: string };

export interface GitRef {
  fullName: string;
  displayName: string;
  kind: "local" | "remote";
}

export interface GitChange {
  kind: "modified" | "added" | "deleted" | "renamed";
  path: string;
  originalPath?: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

async function runGit(
  repositoryRoot: string,
  args: readonly string[],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repositoryRoot, ...args],
      {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      },
    );
    return stdout;
  } catch (error) {
    const processError = error as NodeJS.ErrnoException & {
      stderr?: string;
    };
    const stderr = processError.stderr?.trim() ?? "";
    throw new GitError(
      stderr || processError.message || `git ${args[0] ?? ""} failed`,
      stderr,
    );
  }
}

export async function listBranches(
  repositoryRoot: string,
): Promise<GitRef[]> {
  const output = await runGit(repositoryRoot, [
    "for-each-ref",
    "--format=%(refname)\t%(refname:short)\t%(symref)",
    "refs/heads",
    "refs/remotes",
  ]);

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [fullName, displayName, symbolicTarget] = line.split("\t");
      if (!fullName || !displayName) {
        throw new GitError(`Unexpected ref output: ${line}`, "");
      }

      return {
        fullName,
        displayName,
        symbolicTarget,
        kind: fullName.startsWith("refs/heads/")
          ? ("local" as const)
          : ("remote" as const),
      };
    })
    .filter((ref) => !ref.symbolicTarget)
    .map(({ fullName, displayName, kind }) => ({
      fullName,
      displayName,
      kind,
    }))
    .sort(
      (left, right) =>
        Number(left.kind === "remote") - Number(right.kind === "remote") ||
        left.displayName.localeCompare(right.displayName),
    );
}

async function tryRunGit(
  repositoryRoot: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    return await runGit(repositoryRoot, args);
  } catch (error) {
    if (error instanceof GitError) {
      return undefined;
    }
    throw error;
  }
}

export async function findDefaultBaseline(
  repositoryRoot: string,
): Promise<BaselineSelection | undefined> {
  const branches = await listBranches(repositoryRoot);
  const branchByFullName = new Map(
    branches.map((branch) => [branch.fullName, branch]),
  );
  const remoteRefs =
    (await tryRunGit(repositoryRoot, [
      "for-each-ref",
      "--format=%(refname)\t%(symref)",
      "refs/remotes",
    ])) ?? "";
  const remoteHeadTargets = remoteRefs
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(
      (fields): fields is [string, string] =>
        Boolean(fields[0]?.endsWith("/HEAD") && fields[1]),
    )
    .sort(
      ([left], [right]) =>
        Number(!left.startsWith("refs/remotes/origin/")) -
          Number(!right.startsWith("refs/remotes/origin/")) ||
        left.localeCompare(right),
    )
    .map(([, target]) => target);

  for (const target of remoteHeadTargets) {
    const remoteMatch = /^refs\/remotes\/[^/]+\/(.+)$/.exec(target);
    const localBranch = remoteMatch
      ? branchByFullName.get(`refs/heads/${remoteMatch[1]}`)
      : undefined;
    const branch = localBranch ?? branchByFullName.get(target);
    if (branch) {
      return { kind: "branch", ref: branch.fullName, label: branch.displayName };
    }
  }

  const configuredDefault = (
    await tryRunGit(repositoryRoot, ["config", "--get", "init.defaultBranch"])
  )?.trim();
  const conventionalNames = [
    ...(configuredDefault ? [configuredDefault] : []),
    "main",
    "master",
    "trunk",
  ];
  for (const name of conventionalNames) {
    const localBranch = branchByFullName.get(`refs/heads/${name}`);
    if (localBranch) {
      return {
        kind: "branch",
        ref: localBranch.fullName,
        label: localBranch.displayName,
      };
    }

    const remoteBranch = branches.find(
      (branch) =>
        branch.kind === "remote" && branch.fullName.endsWith(`/${name}`),
    );
    if (remoteBranch) {
      return {
        kind: "branch",
        ref: remoteBranch.fullName,
        label: remoteBranch.displayName,
      };
    }
  }

  const localBranches = branches.filter((branch) => branch.kind === "local");
  if (localBranches.length === 1 && localBranches[0]) {
    return {
      kind: "branch",
      ref: localBranches[0].fullName,
      label: localBranches[0].displayName,
    };
  }

  return undefined;
}

export async function resolveCommit(
  repositoryRoot: string,
  ref: string,
): Promise<string> {
  return (
    await runGit(repositoryRoot, [
      "rev-parse",
      "--verify",
      `${ref}^{commit}`,
    ])
  ).trim();
}

export async function resolveBaseline(
  repositoryRoot: string,
  selection: BaselineSelection,
): Promise<string> {
  if (selection.kind === "commit") {
    return resolveCommit(repositoryRoot, selection.ref);
  }

  const branchCommit = await resolveCommit(repositoryRoot, selection.ref);
  return (
    await runGit(repositoryRoot, ["merge-base", "HEAD", branchCommit])
  ).trim();
}

export function parseNameStatus(output: string): GitChange[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }

  const changes: GitChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    const path = fields[index++];
    if (!status || !path) {
      throw new GitError("Unexpected git diff output", "");
    }

    if (status.startsWith("R")) {
      const renamedPath = fields[index++];
      if (!renamedPath) {
        throw new GitError("Unexpected rename output from git diff", "");
      }
      changes.push({
        kind: "renamed",
        originalPath: path,
        path: renamedPath,
      });
      continue;
    }

    switch (status[0]) {
      case "A":
        changes.push({ kind: "added", path });
        break;
      case "D":
        changes.push({ kind: "deleted", path });
        break;
      default:
        changes.push({ kind: "modified", path });
        break;
    }
  }

  return changes;
}

export async function getChanges(
  repositoryRoot: string,
  baselineCommit: string,
): Promise<GitChange[]> {
  const [diffOutput, untrackedOutput] = await Promise.all([
    runGit(repositoryRoot, [
      "diff",
      "--name-status",
      "-z",
      "-M",
      baselineCommit,
      "--",
    ]),
    runGit(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);

  const changes = parseNameStatus(diffOutput);
  const changeIndex = new Map(
    changes.map((change, index) => [change.path, index]),
  );

  for (const path of untrackedOutput.split("\0").filter(Boolean)) {
    const existingIndex = changeIndex.get(path);
    if (
      existingIndex !== undefined &&
      changes[existingIndex]?.kind === "deleted"
    ) {
      changes[existingIndex] = { kind: "modified", path };
      continue;
    }
    if (existingIndex === undefined) {
      changeIndex.set(path, changes.length);
      changes.push({ kind: "added", path });
    }
  }

  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

export async function readBaselineFile(
  repositoryRoot: string,
  baselineCommit: string,
  path: string,
): Promise<string | undefined> {
  try {
    await runGit(repositoryRoot, [
      "cat-file",
      "-e",
      `${baselineCommit}:${path}`,
    ]);
  } catch (error) {
    if (error instanceof GitError) {
      return undefined;
    }
    throw error;
  }

  return runGit(repositoryRoot, [
    "show",
    `${baselineCommit}:${path}`,
  ]);
}
