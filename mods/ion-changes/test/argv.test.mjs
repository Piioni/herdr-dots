import test from "node:test";
import assert from "node:assert/strict";
import { sideArgv } from "../argv.js";

const ctx = (over = {}) => ({ home: "/h", params: { root: "/r", path: "src/a.js", range: ["HEAD"], hasHead: true, fresh: false, status: "M", ...over } });
const env = (argv) => argv.find((a) => a.startsWith("ION_DIFF_PARAMS="));

test("side by side compares against the scope's ref, and an untracked file opens read-only", () => {
  assert.deepEqual(sideArgv(ctx()).slice(-4), ["-y", "HEAD", "--", "src/a.js"]);
  assert.deepEqual(sideArgv(ctx({ fresh: true })).slice(-3), ["nvim", "-R", "src/a.js"]);
});

test("a picked commit (two refs) is compared parent against commit", () => {
  const argv = sideArgv(ctx({ range: ["p1", "c1"] }));
  assert.deepEqual(argv.slice(argv.indexOf("difftool")), ["difftool", "-y", "p1", "c1", "--", "src/a.js"]);
});

test("a repo without commits has nothing to compare against: it diffs the index", () => {
  assert.deepEqual(sideArgv(ctx({ hasHead: false, status: "M" })).slice(-3), ["-y", "--", "src/a.js"]);
});

test("it carries the params, so the swap key can build the inline view from them", () => {
  assert.deepEqual(JSON.parse(env(sideArgv(ctx())).slice("ION_DIFF_PARAMS=".length)).range, ["HEAD"]);
});
