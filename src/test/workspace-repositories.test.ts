import assert from "node:assert/strict";
import test from "node:test";
import { isWorkspaceRepository } from "../workspace-repositories";

test("only repositories opened as workspace folders are included", () => {
  const workspaceFolders = [
    "file:///worktrees/feature/creci",
    "file:///worktrees/fix/creci",
  ];

  assert.equal(
    isWorkspaceRepository(
      "file:///worktrees/feature/creci",
      workspaceFolders,
    ),
    true,
  );
  assert.equal(
    isWorkspaceRepository(
      "file:///worktrees/other/creci",
      workspaceFolders,
    ),
    false,
  );
});

test("repository URI matching tolerates trailing slashes", () => {
  assert.equal(
    isWorkspaceRepository("file:///worktrees/creci/", [
      "file:///worktrees/creci",
    ]),
    true,
  );
});
