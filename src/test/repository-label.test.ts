import assert from "node:assert/strict";
import test from "node:test";
import { formatRepositoryLabel } from "../repository-label";

test("repository labels distinguish worktrees with the same folder name", () => {
  assert.equal(
    formatRepositoryLabel("/worktrees/first/creci", {
      name: "feature/verification",
    }),
    "Diff Chooser (creci · feature/verification)",
  );
  assert.equal(
    formatRepositoryLabel("/worktrees/second/creci", {
      name: "fix/docker-tsc",
    }),
    "Diff Chooser (creci · fix/docker-tsc)",
  );
});

test("repository labels identify detached HEADs and tolerate missing Git state", () => {
  assert.equal(
    formatRepositoryLabel("/worktrees/creci", {
      commit: "1234567890abcdef",
    }),
    "Diff Chooser (creci · detached@1234567)",
  );
  assert.equal(
    formatRepositoryLabel("/worktrees/creci"),
    "Diff Chooser (creci)",
  );
});
