import test from "node:test";
import assert from "node:assert/strict";
import { signals, lead, nameList, IMPLIED } from "../model.js";

const base = { state: "open", draft: false, reviews: [], requested: [], decision: "", merge: "clean", blocked: false, since: null };
const since = { login: "bo", commits: 2, replies: 1 };

test("signals: problems first, review next, quiet states last", () => {
  assert.deepEqual(signals(base), ["needs", "merge-clean"]);
  assert.deepEqual(signals({ ...base, merge: "conflicts", decision: "CHANGES_REQUESTED" }), ["conflicts", "changes"]);
  assert.deepEqual(signals({ ...base, decision: "APPROVED", blocked: true }), ["blocked", "approved", "merge-clean"]);
  assert.deepEqual(signals({ ...base, merge: "behind", since }), ["behind", "since", "needs"]);
  assert.deepEqual(signals({ ...base, merge: "unknown" }), ["needs", "merge-unknown"]);
  assert.deepEqual(signals({ ...base, state: "merged" }), []);
});

test("signals: blocked only counts on an approved PR, drafts only say draft", () => {
  assert.deepEqual(signals({ ...base, blocked: true }), ["needs", "merge-clean"]);
  assert.deepEqual(signals({ ...base, draft: true, merge: "conflicts" }), ["draft"]);
  assert.deepEqual(signals({ ...base, draft: true, merge: "behind", since }), ["since", "draft"]);
});

test("lead: the first loud signal not implied by the section gets the capsule", () => {
  assert.deepEqual(lead(base), { primary: "needs", rest: ["merge-clean"] });
  assert.deepEqual(lead(base, "needs"), { primary: null, rest: ["merge-clean"] });
  assert.deepEqual(lead({ ...base, merge: "conflicts" }, "needs"), { primary: "conflicts", rest: [] });
  assert.deepEqual(lead({ ...base, merge: "unknown" }, "needs"), { primary: null, rest: ["merge-unknown"] });
  assert.deepEqual(lead({ ...base, merge: "behind", since }), { primary: "behind", rest: ["since", "needs"] });
});

test("mine: an approved PR waiting on its merge still says approved", () => {
  const approvedBehind = { ...base, decision: "APPROVED", merge: "behind" };
  assert.deepEqual(lead(approvedBehind, IMPLIED.mine.waiting), { primary: "behind", rest: ["approved"] });
  assert.deepEqual(lead({ ...base, decision: "APPROVED" }, IMPLIED.mine.ready), { primary: null, rest: ["merge-clean"] });
  assert.equal(IMPLIED.mine.attention, undefined);
});

test("nameList fits names in a capsule", () => {
  assert.equal(nameList([]), "");
  assert.equal(nameList(["ana"]), "ana");
  assert.equal(nameList(["ana", "bo"]), "ana, bo");
  assert.equal(nameList(["ana", "bo", "cy"]), "ana, bo +1");
  assert.equal(nameList(["ana", "bo", "cy", "di", "ed"]), "ana, bo +3");
  assert.equal(nameList(["ana", "bo", "cy"], 1), "ana +2");
});
