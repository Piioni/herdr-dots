// Pure diff logic: no host imports, so it runs under `node --test`.
// Row and fill logic adapted from herdr-reviewer (MIT, see NOTICE).
import { tokenize } from "./highlight.js";

// Diff lines shown at most; with the unchanged lines filled in, file lines at
// most (a bigger file shows its hunks only). A fold this short is just shown.
export const DIFF_LINES = 20000, FILE_LINES = 30000, FILE_BYTES = 2_000_000, SHORT_GAP = 2;

// Numbers each diff line once and tokenizes it, so a frame only draws the rows on screen.
// A line starting with "=" is an unchanged line outside the hunks (see fillGaps):
// a context row with `gap` set to its run's number and no hunk.
// The new side and the removed lines keep their own tokenizer state, so a
// comment opened in one isn't carried into the other.
export function diffRows(lines, lang) {
  let old = 1, next = 1, state = null, oldState = null, hunk = -1, gap = -1, inGap = false;
  return lines.map((line, i) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; oldState = null; hunk = i; inGap = false; return { kind: "@", text: line, hunk: i, spans: [{ text: line, cls: "" }] }; }
    const kind = line[0];
    let row;
    if (kind === "=") { if (!inGap) { gap++; inGap = true; } old++; row = { kind: " ", number: next++, text: line.slice(1) || " ", gap }; }
    else if (kind === "-") row = { kind, number: old++, text: line.slice(1) || " " };
    else if (kind === "+") row = { kind, number: next++, text: line.slice(1) || " " };
    else if (kind === " ") { old++; row = { kind, number: next++, text: line.slice(1) || " " }; }
    else row = { kind: "", text: line };
    if (kind !== "=") inGap = false;
    row.hunk = kind === "=" ? -1 : hunk;
    const removed = kind === "-", t = tokenize(row.text.replace(/\t/g, "    "), lang, removed ? oldState : state);
    row.spans = t.spans;
    if (removed) oldState = t.state; else if (row.kind) state = t.state;
    return row;
  });
}

// The diff's lines with the file's unchanged lines around and between the
// hunks added as "=" lines. `text` is the new side of the file. Returns the
// diff as it was when the file doesn't match it (changed since the diff
// was read) or is too big.
export function fillGaps(lines, text) {
  if (text.length > FILE_BYTES || text.includes("\0")) return lines;
  const file = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  if (file.length > FILE_LINES) return lines;
  const out = [];
  let next = 1;
  for (const line of lines) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(line);
    if (match) {
      // An empty new side ("+12,0") starts after line 12, not at it.
      const start = match[2] === "0" ? +match[1] + 1 : +match[1];
      if (start < next) return lines;
      for (; next < start; next++) out.push(`=${file[next - 1]}`);
    } else if (line[0] === "+" || line[0] === " ") {
      if (file[next - 1] !== line.slice(1)) return lines;
      next++;
    }
    out.push(line);
  }
  for (; next <= file.length; next++) out.push(`=${file[next - 1]}`);
  return out;
}

// The list's items: every row, with a closed fold as one "N unchanged lines"
// item in place of its rows. A fold is open in `full` mode, when clicked
// (`unfolded` holds gap numbers) or when it is too short to be worth folding.
export function buildItems(rows, { full, unfolded }) {
  const size = [];
  for (const r of rows) if (r.gap !== undefined) size[r.gap] = (size[r.gap] ?? 0) + 1;
  const items = [], seen = new Set();
  rows.forEach((r, i) => {
    if (r.gap === undefined || full || unfolded.has(r.gap) || size[r.gap] <= SHORT_GAP) items.push({ key: `r:${i}`, kind: "row", i });
    else if (!seen.has(r.gap)) { seen.add(r.gap); items.push({ key: `f:${r.gap}`, kind: "fold", gap: r.gap, count: size[r.gap] }); }
  });
  return items;
}
