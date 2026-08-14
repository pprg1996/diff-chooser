import assert from "node:assert/strict";
import test from "node:test";
import {
  formatWorktreeGroupLabel,
  formatWorktreeName,
} from "../repository-label";

test("worktree names use branches to distinguish identical folder names", () => {
  assert.equal(
    formatWorktreeName("/worktrees/first/creci", {
      name: "feature/verification",
    }),
    "feature/verification",
  );
  assert.equal(
    formatWorktreeName("/worktrees/second/creci", {
      name: "fix/docker-tsc",
    }),
    "fix/docker-tsc",
  );
});

test("worktree names identify detached HEADs and tolerate missing Git state", () => {
  assert.equal(
    formatWorktreeName("/worktrees/creci", {
      commit: "1234567890abcdef",
    }),
    "detached@1234567",
  );
  assert.equal(formatWorktreeName("/worktrees/creci"), "creci");
});

test("worktree group labels show their independent baselines", () => {
  assert.equal(
    formatWorktreeGroupLabel(
      "/worktrees/creci",
      { name: "feature/verification" },
      { kind: "branch", ref: "refs/heads/main", label: "main" },
    ),
    "feature/verification → main",
  );
  assert.equal(
    formatWorktreeGroupLabel("/worktrees/creci", { name: "main" }, undefined),
    "main → Select baseline",
  );
});
