import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  getChanges,
  readBaselineFile,
  resolveBaseline,
} from "../git";

const execFileAsync = promisify(execFile);

async function git(repositoryRoot: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repositoryRoot, ...args],
    { encoding: "utf8" },
  );
  return stdout.trim();
}

async function createRepository(): Promise<string> {
  const repositoryRoot = await mkdtemp(
    path.join(process.cwd(), ".test-repository-"),
  );
  await git(repositoryRoot, "init", "-b", "main");
  await git(repositoryRoot, "config", "user.name", "Diff Chooser Tests");
  await git(
    repositoryRoot,
    "config",
    "user.email",
    "diff-chooser@example.invalid",
  );
  return repositoryRoot;
}

async function write(
  repositoryRoot: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = path.join(repositoryRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function commitAll(
  repositoryRoot: string,
  message: string,
): Promise<string> {
  await git(repositoryRoot, "add", "--all");
  await git(repositoryRoot, "commit", "-m", message);
  return git(repositoryRoot, "rev-parse", "HEAD");
}

test("branch selections use the merge base and include committed and working changes", async (t) => {
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));

  await write(repositoryRoot, "shared.txt", "base\n");
  const divergenceCommit = await commitAll(repositoryRoot, "base");

  await git(repositoryRoot, "checkout", "-b", "feature");
  await write(repositoryRoot, "feature.txt", "committed feature work\n");
  await commitAll(repositoryRoot, "feature work");

  await git(repositoryRoot, "checkout", "main");
  await write(repositoryRoot, "main-only.txt", "new work on main\n");
  const mainTip = await commitAll(repositoryRoot, "main advances");

  await git(repositoryRoot, "checkout", "feature");
  await write(repositoryRoot, "shared.txt", "uncommitted feature work\n");
  await write(repositoryRoot, "notes with spaces.txt", "untracked\n");

  const branchBaseline = await resolveBaseline(repositoryRoot, {
    kind: "branch",
    ref: "refs/heads/main",
    label: "main",
  });
  assert.equal(branchBaseline, divergenceCommit);
  assert.deepEqual(await getChanges(repositoryRoot, branchBaseline), [
    { kind: "added", path: "feature.txt" },
    { kind: "added", path: "notes with spaces.txt" },
    { kind: "modified", path: "shared.txt" },
  ]);

  const exactBaseline = await resolveBaseline(repositoryRoot, {
    kind: "commit",
    ref: mainTip,
    label: mainTip.slice(0, 12),
  });
  assert.equal(exactBaseline, mainTip);
});

test("changes preserve deletions, renames, untracked paths, and baseline content", async (t) => {
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));

  await write(repositoryRoot, "delete me.txt", "deleted content\n");
  await write(repositoryRoot, "old name.txt", "renamed content\n");
  const baselineCommit = await commitAll(repositoryRoot, "base files");

  await git(repositoryRoot, "mv", "old name.txt", "new name.txt");
  await git(repositoryRoot, "rm", "delete me.txt");
  await write(repositoryRoot, "untracked path.txt", "new content\n");

  assert.deepEqual(await getChanges(repositoryRoot, baselineCommit), [
    { kind: "deleted", path: "delete me.txt" },
    {
      kind: "renamed",
      originalPath: "old name.txt",
      path: "new name.txt",
    },
    { kind: "added", path: "untracked path.txt" },
  ]);
  assert.equal(
    await readBaselineFile(
      repositoryRoot,
      baselineCommit,
      "old name.txt",
    ),
    "renamed content\n",
  );
  assert.equal(
    await readBaselineFile(
      repositoryRoot,
      baselineCommit,
      "new name.txt",
    ),
    undefined,
  );
});
