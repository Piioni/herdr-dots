// A file's diff in its own tab (tab.new {mod: "ion-diff", props}) or popup (openOverlay), opened by ion-changes.
// One Dark colors, line numbers, tinted added/removed rows, syntax, unchanged lines folded (click, or "Full file", to show them).
// Right-click a line or a hunk header, or use "Ask about diff", to send it to an agent (dialog.js).
// The list is virtual with one row height, so a large diff costs what is on screen.
// Props: { root, on, path, range, hasHead, fresh, status, label, words, nvim?, font_size? }
//   range: git refs the working tree (one ref) or a commit (two refs) is diffed against; label/words: the scope in a word / a sentence.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, readTextFile, watchFolder, theme, settings, props, shared, setShared, openOverlay, closeOverlay, focused, run } from "herdr";
import { languageOf } from "./highlight.js";
import { diffRows, fillGaps, buildItems, DIFF_LINES } from "./diff.js";
import { Dialog } from "./dialog.js";

const NONE = "#00000000", FULL = "ion-diff.full";
// Same flags as ion-changes: automatic reads never take index.lock nor rewrite the index.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const codeFont = () => (typeof settings().font === "string" && settings().font) || "JetBrains Mono";
const codeSize = () => Number(props()?.font_size) || Math.max(9, (Number(settings().font_size) || 14) - 1);
const rowOf = (size) => Math.round(size * 1.8);
const charOf = (size) => size * 0.62;
// One Dark (Atom / One Dark Pro) colors; the background stays the Herdr theme's, like your transparent Neovim.
const ONE_DARK = { foreground: "#abb2bf", dim: "#5c6370", muted: "#7f848e", raised: "#2c313a", hover: "#323842", border: "#3e4451", accent: "#61afef", ansi1: "#e06c75", ansi2: "#98c379" };
const look = () => ({ ...theme(), ...ONE_DARK });
const palette = (t) => ({ keyword: "#c678dd", string: "#98c379", comment: "#7f848e", function: "#61afef", type: "#e5c07b", number: "#d19a66", boolean: "#d19a66", variable: "#e06c75", added: t.ansi2, removed: t.ansi1 });
const max = (xs) => xs.reduce((m, x) => (x > m ? x : m), 0);

export default class Diff extends View {
  init(_props, cx) {
    // Opened as the ask dialog: this copy is the dialog, nothing else.
    if (props()?.dialog) { this.dialog = Object.create(Dialog.prototype); this.dialog.init(_props, cx); return; }
    this.p = props() ?? {};
    this.rows = []; this.items = []; this.lines = null; this.unfolded = new Set(); this.gutter = 30; this.diffWidth = 0;
    this.fontSize = codeSize(); this.row = rowOf(this.fontSize); this.scroll = VirtualListScrollHandle.new();
    this.reload(cx);
    cx.timer.every(10000, (cx) => this.reload(cx));
    if (!this.p.on) cx.spawn(async (cx) => {
      try { for (;;) { await watchFolder(this.p.root); this.reload(cx); } } catch { /* the timer keeps refreshing */ }
    });
  }

  reload(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try { await this.load(); this.error = null; }
      catch (e) { this.error = `Cannot preview this diff: ${e}`; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load() {
    const { root, on, path, hasHead, fresh, status } = this.p, range = hasHead ? this.p.range ?? ["HEAD"] : [];
    let lines;
    this.note = null;
    if (fresh || (!hasHead && status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        const all = text.replace(/\n$/, "").split("\n");
        lines = [`@@ -0,0 +1,${all.length} @@`, ...all.slice(0, DIFF_LINES).map((l) => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...range, "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? ["No text diff available (binary file, or only the mode changed)"] : all.slice(first);
      // The unchanged lines around the hunks come from the new side: the picked commit's blob, else the working tree.
      if (first >= 0 && lines.length <= DIFF_LINES && status !== "D") {
        const commit = range.length === 2 ? range[1] : null;
        const text = commit ? await exec("git", [...READ, "show", `${commit}:${path}`], { cwd: root, on }).then((s) => (s.code === 0 ? s.stdout : null)).catch(() => null)
          : await readTextFile(`${root}/${path}`, { on }).catch(() => null);
        if (typeof text === "string") lines = fillGaps(lines, text);
      }
    }
    if (lines.length > DIFF_LINES && !lines.some((l) => l[0] === "=")) { this.note = `Showing the first ${DIFF_LINES.toLocaleString()} lines of the diff`; lines = lines.slice(0, DIFF_LINES); }
    this.setLines(lines.map((l) => (l.length > 4000 ? `${l.slice(0, 4000)}… (line truncated)` : l)));
  }

  setLines(lines) {
    if (this.lines && lines.length === this.lines.length && lines.every((l, i) => l === this.lines[i])) return;
    this.lines = lines;
    this.rows = diffRows(lines, languageOf(this.p.path));
    this.measure();
  }

  // Sizes that depend on the font: the gutter (wide enough for the largest line number) and the diff's width.
  measure() {
    const ch = charOf(this.fontSize);
    this.add = this.rows.filter((r) => r.kind === "+").length; this.del = this.rows.filter((r) => r.kind === "-").length;
    this.gutter = Math.max(30, Math.ceil(String(max(this.rows.map((r) => r.number ?? 0))).length * ch + 10));
    this.diffWidth = Math.max(300, max((this.lines ?? []).map((l) => Math.ceil(l.length * ch) + this.gutter + 36)));
    this.rebuild();
  }
  rebuild() { this.builtFull = this.full(); this.items = buildItems(this.rows, { full: this.builtFull, unfolded: this.unfolded }); }

  full() { return shared(FULL) === true; }
  toggleFull(cx) { setShared(FULL, !this.full()); this.unfolded = new Set(); this.rebuild(); cx.notify(); }
  unfold(g, cx) { this.unfolded.add(g); this.rebuild(); cx.notify(); }

  // The text the agent gets for a set of rows.
  quote(rows) {
    return rows.map((r) => (r.kind === "@" ? r.text : `${r.number === undefined ? "" : String(r.number).padStart(5)} ${r.kind || " "} ${r.text}`)).join("\n");
  }
  span(rows) {
    const nums = rows.filter((r) => r.number !== undefined && r.kind !== "-").map((r) => r.number), olds = rows.filter((r) => r.kind === "-").map((r) => r.number);
    const range = (a) => (a.length > 1 ? `lines ${Math.min(...a)}-${Math.max(...a)}` : `line ${a[0]}`);
    return nums.length ? range(nums) : olds.length ? `removed ${range(olds)}` : "";
  }

  // Swap to the side-by-side diff in Neovim (props.nvim is its command): a tab for it, and this viewer goes.
  sideBySide() {
    const { nvim, root, path } = this.p, overlay = props()?.overlay, pane = focused()?.pane;
    run("tab.new", { name: `diff · ${path.split("/").pop()}`, folder: root, argv: nvim });
    if (overlay) closeOverlay(overlay); else if (pane) run("pane.close", { pane });
  }

  // `indexes`: the rows to ask about; null: the whole diff (its hunks, not the unchanged lines filled in around them).
  askAbout(indexes) {
    if (!this.rows.length) return;
    const rows = (indexes ?? this.rows.map((r, i) => (r.gap === undefined ? i : -1)).filter((i) => i >= 0)).slice(0, 400).map((i) => this.rows[i]).filter(Boolean);
    const span = this.span(rows), { root, on, path, words } = this.p, where = `${root}/${path}${on ? ` (on ${on})` : ""}`;
    const head = indexes ? `In ${where}, ${span || "these lines"} of the diff (${words}; new-file line numbers; - lines are removed):` : `The diff of ${where} (${words}):`;
    openOverlay({ mod: "ion-diff", kind: "dialog", width: 680, height: 560, props: { dialog: true, title: `${path}${span ? `:${span.replace(/^(removed )?lines? /, "")}` : ""}`, context: `${head}\n${this.quote(rows)}` } });
  }

  item(it, t, colors) {
    if (it.kind === "fold") {
      return h_flex().w_full().h(this.row).flex_none().items_center().cursor_pointer().bg(t.raised + "80").text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .child(div().w(this.gutter + 16).flex_none().text_center().child("⋯"))
        .child(div().flex_1().min_w(0).truncate().text_size(this.fontSize - 1).child(`${it.count} unchanged line${it.count > 1 ? "s" : ""} · click to show`));
    }
    const { kind, number, spans } = this.rows[it.i];
    if (kind === "@") {
      return h_flex().w_full().h(this.row).flex_none().items_center().bg(t.raised)
        .child(div().w(this.gutter + 16).flex_none()).child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(spans[0].text));
    }
    const tint = kind === "+" ? colors.added : kind === "-" ? colors.removed : null;
    return h_flex().w_full().h(this.row).flex_none()
      .when(Boolean(tint), (e) => e.bg(tint + "30"))
      .child(div().w(this.gutter).flex_none().text_right().pr(4).when(Boolean(tint), (e) => e.bg(tint + "26")).text_color(tint ? t.foreground + "cc" : t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(16).flex_none().text_center().font_bold().text_color(tint ?? NONE).child(kind === "+" ? "+" : kind === "-" ? "−" : " "))
      .child(h_flex().flex_1().min_w(0).whitespace_nowrap().children(spans.map((s) => (s.cls ? div().text_color(colors[s.cls] ?? t.foreground).child(s.text) : div().child(s.text)))));
  }

  render(cx) {
    if (this.dialog) return this.dialog.render(cx);
    const size = codeSize();
    if (size !== this.fontSize) { this.fontSize = size; this.row = rowOf(size); this.measure(); }
    // "Full file" may have been switched in another viewer.
    else if (this.full() !== this.builtFull) this.rebuild();
    const t = look(), colors = palette(t), { label } = this.p, parts = (this.p.path ?? "").split("/"), name = parts.pop();
    const hasGaps = this.rows.some((r) => r.gap !== undefined);
    const button = (id, text, active, tip, action) => div().id(id).h(24).px(10).flex().items_center().rounded(6).border_1().border_color(active ? t.accent : t.border)
      .bg(active ? t.accent + "22" : t.raised).text_size(12).text_color(active ? t.accent : t.foreground).cursor_pointer().hover((s) => s.opacity(0.88)).tooltip(tip).on_click(action).child(text);
    return v_flex().id("diff").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(h_flex().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? `${parts.join("/")}/` : "")).child(div().flex_none().font_semibold().child(name)))
        .when(Boolean(label), (e) => e.child(div().flex_none().h(24).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.muted).child(label)))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.ansi2).child(`+${this.add ?? 0}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${this.del ?? 0}`))
        .when(hasGaps, (e) => e.child(button("full-file", "Full file", this.full(), this.full() ? "Fold the unchanged lines" : "Show the whole file", (_e, cx) => this.toggleFull(cx))))
        .when(Boolean(this.p.nvim), (e) => e.child(button("side-by-side", "Side-by-side", false, "Open this diff in Neovim, side by side", () => this.sideBySide())))
        .when(this.rows.length > 0, (e) => e.child(button("ask", "Ask about diff", false, "Send the diff of this file to an agent. Right-click a line or a hunk to ask about just that", () => this.askAbout(null)))))
      .child(div().flex_1().min_w(0).min_h(0).relative().font_family(codeFont()).text_size(this.fontSize)
        .child(div().id("diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("ion-diff-list", this.items.length, this.row, (i) => this.items[i].key,
            (range) => this.items.slice(range.start, range.end).map((it) => this.item(it, t, colors))).size_full().track_scroll(this.scroll)
            .on_item_click((k, cx) => { if (k.startsWith("f:")) this.unfold(Number(k.slice(2)), cx); })
            .on_item_secondary_click((k, _e, cx) => {
              if (!k.startsWith("r:")) return;
              const i = Number(k.slice(2)), r = this.rows[i];
              if (!r || r.kind === "") return;
              this.askAbout(r.kind === "@" ? this.rows.map((_r, j) => j).filter((j) => this.rows[j].hunk === i && this.rows[j].kind !== "") : [i]);
            }))))
        .child(Scrollbar.vertical("ion-diff-list").viewport_from_layout().absolute().inset_0())
        .when(!this.rows.length, (e) => e.child(div().absolute().top(6).px(14).text_color(this.error ? t.ansi1 : t.dim).child(this.error || (this.loading ? "Loading diff…" : "No changes"))))
        .when(this.rows.length > 0, (e) => e.child(div().absolute().bottom(6).right(14).px(8).py(3).rounded(6).bg(t.raised + "e0").text_size(10).text_color(t.dim).child("Right-click a line to ask"))))
      .when(Boolean(this.note), (e) => e.child(div().px(14).py(4).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child(this.note)));
  }
}
