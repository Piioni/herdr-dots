import test from "node:test";
import assert from "node:assert/strict";
import { diffRows, fillGaps, buildItems } from "../diff.js";

const file = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
// New side: line 5 changed (was "old5"), line 15 added after l14.
const newText = file.replace("l5\n", "new5\n").replace("l14\n", "l14\nadded\n");
const diff = ["@@ -4,3 +4,3 @@", " l4", "-old5", "+new5", " l6", "@@ -13,2 +13,3 @@", " l13", " l14", "+added"];

test("fillGaps adds the unchanged lines before, between and after the hunks", () => {
  const out = fillGaps(diff, newText);
  assert.equal(out.filter((l) => l[0] === "=").length, 3 + 6 + 6);
  assert.equal(out[0], "=l1");
  assert.equal(out.at(-1), "=l20");
  assert.equal(out.length, diff.length + 15);
});

test("fillGaps returns the diff untouched when the file no longer matches it", () => {
  assert.deepEqual(fillGaps(diff, "something\nelse\n"), diff);
});

test("diffRows numbers both sides and groups each unchanged run as one gap", () => {
  const rows = diffRows(fillGaps(diff, newText), null);
  const removed = rows.find((r) => r.kind === "-");
  assert.equal(removed.number, 5);
  assert.equal(rows.find((r) => r.kind === "+" && r.text === "new5").number, 5);
  assert.equal(rows.find((r) => r.kind === "+" && r.text === "added").number, 15);
  assert.deepEqual([...new Set(rows.filter((r) => r.gap !== undefined).map((r) => r.gap))], [0, 1, 2]);
});

test("buildItems folds a long gap into one row and shows short ones", () => {
  const rows = diffRows(fillGaps(diff, newText), null);
  const items = buildItems(rows, { full: false, unfolded: new Set() });
  const folds = items.filter((i) => i.kind === "fold");
  assert.deepEqual(folds.map((f) => f.count), [3, 6, 6]);
  assert.equal(items.filter((i) => i.kind === "row").length, rows.filter((r) => r.gap === undefined).length);
});

test("buildItems shows an unfolded gap and everything in full mode", () => {
  const rows = diffRows(fillGaps(diff, newText), null);
  const one = buildItems(rows, { full: false, unfolded: new Set([1]) });
  assert.deepEqual(one.filter((i) => i.kind === "fold").map((f) => f.gap), [0, 2]);
  const all = buildItems(rows, { full: true, unfolded: new Set() });
  assert.equal(all.filter((i) => i.kind === "fold").length, 0);
  assert.equal(all.length, rows.length);
});

test("buildItems does not fold a gap of two lines or fewer", () => {
  const rows = diffRows(["@@ -1,1 +1,1 @@", "=a", "=b", "-x", "+y"], null);
  assert.equal(buildItems(rows, { full: false, unfolded: new Set() }).filter((i) => i.kind === "fold").length, 0);
});
