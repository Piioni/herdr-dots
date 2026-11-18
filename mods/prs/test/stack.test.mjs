import test from "node:test";
import assert from "node:assert/strict";
import { stacked, nest } from "../model.js";

const pr = (number, head, base) => ({ number, head, base, title: `PR ${number}` });

test("stacks: parents, trunk by majority, off-trunk bases and nested order", () => {
  const list = stacked([pr(1, "a", "develop"), pr(2, "b", "a"), pr(3, "c", "develop"), pr(4, "d", "b"), pr(5, "e", "main")]);
  const by = Object.fromEntries(list.map((p) => [p.number, p]));
  assert.equal(by[1].trunk, "develop");
  assert.deepEqual([by[1].parent, by[2].parent, by[4].parent], [null, 1, 2]);
  assert.deepEqual(list.map((p) => p.offTrunk), [false, true, false, true, true]);
  assert.deepEqual(nest(list).map(({ p, depth }) => [p.number, depth]), [[1, 0], [2, 1], [4, 2], [3, 0], [5, 0]]);
  assert.deepEqual(nest(list.filter((p) => p.number !== 1)).map(({ p, depth }) => [p.number, depth]), [[2, 0], [4, 1], [3, 0], [5, 0]]);
});

test("stacks: a release PR from the trunk and a fork's same-named branch are not parents", () => {
  const list = stacked([pr(1, "develop", "main"), pr(2, "a", "develop"), pr(3, "b", "develop"), { ...pr(4, "main", "main"), fork: true }, pr(5, "c", "a"), pr(6, "d", "develop")]);
  assert.deepEqual(list.map((p) => p.parent), [null, null, null, null, 2, null]);
  assert.deepEqual(list.map((p) => p.offTrunk), [true, false, false, true, true, false]);
});

test("stacks: ties go to the long-lived branch, shared heads have no parent", () => {
  const tie = stacked([pr(1, "develop", "main"), pr(2, "feat", "develop")]);
  assert.equal(tie[0].trunk, "develop");
  assert.deepEqual(tie.map((p) => p.parent), [null, null]);
  const chain = stacked([pr(1, "a", "develop"), pr(2, "b", "a")]);
  assert.equal(chain[0].trunk, "develop");
  assert.equal(chain[1].parent, 1);
  const shared = stacked([pr(1, "feat", "develop"), pr(2, "feat", "main"), pr(3, "x", "feat"), pr(4, "y", "develop")]);
  assert.equal(shared[2].parent, null);
});
