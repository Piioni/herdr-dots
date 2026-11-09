import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, Popover } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, run, appHome, openOverlay } from "herdr";
import { neovimTab, neovimPopup, openTab, openPopup } from "./terminal.js";
import { iconFor } from "./icons.js";
import { sideArgv } from "./argv.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* remembering the choice is optional */ } },
};
// The scope chosen per repo: "work", "last", "branch" or "commit:<sha>".
const remembered = {
  get: (k) => { try { return JSON.parse(store.get("scopes") ?? "{}")[k] ?? null; } catch { return null; } },
  set: (k, v) => { try { store.set("scopes", JSON.stringify({ ...JSON.parse(store.get("scopes") ?? "{}"), [k]: v })); } catch { /* optional */ } },
};
const LOG_SIZE = 100;

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.message = ""; this.handle = cx.focus_handle();
    this.view = store.get("view") === "folders" ? "folders" : "flat"; this.collapsed = new Set(); this.hover = null;
    this.scope = "work"; this.sha = null; this.scopeInfo = null; this.range = ["HEAD"]; this.log = null; this.choosingScope = false;
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx, settled = false) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context && this.context !== undefined && !settled) {
      // While a pane or tab opens, focus passes through other folders for a moment: take a new one only once it holds.
      if (this.pending !== context) {
        this.pending = context;
        cx.timer.after(800, (cx) => { if (this.pending === context) { this.pending = null; if (key() === context) this.refresh(cx, true); } });
      }
      return;
    }
    this.context = context;
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        // Focus moving to another pane (a new diff tab, say) is not a new repo: keep what the person set up.
        if (root !== this.root || on !== this.on) {
          this.files = []; this.open = null; this.collapsed = new Set(); this.message = ""; this.input.set_value(""); this.note = null; this.limited = false; this.log = null;
        }
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const hasHead = head.code === 0;
        // The scope in use (remembered per repo) and what this repo offers.
        const scopeKey = `${on ?? ""}:${root}`, saved = remembered.get(scopeKey);
        let [scope, sha] = root === this.root ? [this.scope, this.sha] : saved?.startsWith("commit:") ? ["commit", saved.slice(7)] : [saved ?? "work", null];
        const info = hasHead ? await this.scopes(git, scope === "commit" ? sha : null) : { branch: null, base: null, last: null, merge: null, commit: null };
        if ((scope === "branch" && !info.merge) || (scope === "last" && !info.last) || (scope === "commit" && !info.commit) || !hasHead) scope = "work";
        if (scope !== "commit") sha = null;
        // What is diffed: the working tree against one ref, or a picked commit against its parent.
        const range = scope === "commit" ? [info.commit.parent, info.commit.sha] : [scope === "branch" ? info.merge : scope === "last" ? `${info.last}~1` : "HEAD"];
        const stats = {}, changed = new Map();
        const results = hasHead ? [await git(["diff", ...range, "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        if (hasHead) {
          const names = await git(["diff", ...range, "--name-status", "-z", "--no-renames"]);
          if (names.code !== 0) throw new Error(names.stderr);
          const parts = names.stdout.split("\0");
          // With diff.autoRefreshIndex off, a file touched without a content change is listed as M with no numstat line: skip it.
          for (let i = 0; i + 1 < parts.length && parts[i]; i += 2) { if (parts[i][0] !== "M" || stats[parts[i + 1]]) changed.set(parts[i + 1], parts[i][0]); }
        }
        // A picked commit is history: the working tree's state is not part of it.
        const entries = scope === "commit" ? [] : status.stdout.split("\0").filter(Boolean);
        for (const entry of entries) {
          const xy = entry.slice(0, 2), path = entry.slice(3);
          if (xy === "??") changed.set(path, "?");
          else if (xy.includes("U") || xy === "AA" || xy === "DD") changed.set(path, "U");
          else if (!hasHead) changed.set(path, xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M");
        }
        const files = [];
        for (const [path, s0] of [...changed.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 1000)) {
          const fresh = s0 === "?", s = fresh ? "A" : s0 === "D" || s0 === "A" || s0 === "U" ? s0 : "M";
          files.push({ path, status: s, fresh, ...(stats[path] ?? { add: 0, del: 0 }) });
        }
        if (key() !== context) return;
        if (scope !== this.scope || sha !== this.sha) this.open = null;
        this.root = root; this.on = on; this.hasHead = hasHead; this.scope = scope; this.sha = sha; this.scopeInfo = info; this.range = range;
        this.files = files; this.limited = changed.size > 1000; this.error = null;
        this.watch(root, cx);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; if (this.again) { this.again = false; this.refresh(cx); } cx.notify(); }
    });
  }

  // What this repo can be reviewed against: its branch, the base branch (main, else master, else origin/HEAD's),
  // the merge base with it (null when on the base itself), HEAD's short hash when it has a parent,
  // and the picked commit `sha` with its parent (null when it is gone).
  async scopes(git, sha) {
    const out = async (args) => { const r = await git(args); return r.code === 0 ? r.stdout.trim() : null; };
    const branch = await out(["rev-parse", "--abbrev-ref", "HEAD"]);
    let base = (await out(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]))?.replace(/^refs\/remotes\/origin\//, "") ?? null;
    if (!base) for (const b of ["main", "master"]) { if (await out(["rev-parse", "--verify", "-q", `refs/heads/${b}`]) !== null) { base = b; break; } }
    let merge = null;
    if (base && branch !== base) {
      const baseRef = (await out(["rev-parse", "--verify", "-q", `refs/heads/${base}`])) !== null ? base : `origin/${base}`;
      merge = await out(["merge-base", baseRef, "HEAD"]);
      if (merge && (await out(["rev-parse", "HEAD"])) === merge) merge = null;
    }
    const last = (await out(["rev-parse", "--verify", "-q", "HEAD~1"])) !== null ? await out(["rev-parse", "--short", "HEAD"]) : null;
    const subject = last ? await out(["log", "-1", "--format=%s"]) : null;
    let commit = null;
    if (sha) {
      const found = await out(["log", "-1", "--format=%H%x1f%h%x1f%s", `${sha}^{commit}`, "--"]);
      if (found) {
        const [full, short, title] = found.split("\x1f");
        // A root commit is diffed against the empty tree.
        const parent = (await out(["rev-parse", "--verify", "-q", `${full}~1`])) ?? (await out(["hash-object", "-t", "tree", "/dev/null"]));
        if (parent) commit = { sha: full, short, subject: title, parent };
      }
    }
    return { branch, base, merge, last, subject, commit };
  }

  scopeLabel() {
    const i = this.scopeInfo ?? {};
    return this.scope === "branch" ? `vs ${i.base}` : this.scope === "last" ? "Last commit" : this.scope === "commit" ? `Commit ${i.commit?.short ?? ""}` : "Uncommitted";
  }
  // The scope in a sentence, for the agent.
  scopeWords() {
    const i = this.scopeInfo ?? {};
    return this.scope === "branch" ? `all changes on branch ${i.branch} since it left ${i.base} (merge base ${(i.merge ?? "").slice(0, 7)}), committed or not`
      : this.scope === "last" ? `the last commit (${i.last}${i.subject ? `, "${i.subject}"` : ""}) plus the uncommitted changes`
      : this.scope === "commit" ? `commit ${i.commit?.short}${i.commit?.subject ? ` ("${i.commit.subject}")` : ""} on its own, against its parent`
      : "uncommitted changes";
  }
  // `sha`: the commit, for the "commit" scope.
  setScope(scope, cx, sha = null) {
    this.choosingScope = false;
    if (!this.root || (scope === this.scope && sha === this.sha)) { cx.notify(); return; }
    remembered.set(`${this.on ?? ""}:${this.root}`, scope === "commit" ? `commit:${sha}` : scope);
    this.scope = scope; this.sha = sha; this.open = null;
    // A refresh already running would read the old scope: run another when it ends.
    if (this.loading) this.again = true; else this.refresh(cx);
    cx.notify();
  }
  // The commits for the picker, read when it opens: on a branch that has left its base, the branch's own
  // (first-parent, since the merge base); else the last LOG_SIZE on HEAD.
  loadLog(cx) {
    const root = this.root, on = this.on, context = this.context, merge = this.scopeInfo?.merge;
    if (!root || !this.hasHead) return;
    cx.spawn(async (cx) => {
      const r = await exec("git", [...READ, "log", "--first-parent", `-n${LOG_SIZE}`, "--format=%H%x1f%h%x1f%s%x1f%ar%x1f%an", ...(merge ? [`${merge}..HEAD`] : []), "--"], { cwd: root, on });
      if (key() !== context || root !== this.root) return;
      this.log = r.code !== 0 ? [] : r.stdout.split("\n").filter(Boolean).map((l) => { const [sha, short, subject, when, author] = l.split("\x1f"); return { sha, short, subject, when, author }; });
      cx.notify();
    });
  }

  // A deleted file has nothing to open.
  openFile(file, popup, cx) {
    if (!this.root || file.status === "D") return;
    const abs = `${this.root}/${file.path}`;
    if (popup && !this.on) neovimPopup(this.root, abs, cx); else neovimTab(this.root, abs);
  }

  // What the diff views need: the file and what it is diffed against.
  viewerProps(file) {
    return { root: this.root, on: this.on, path: file.path, range: this.range, hasHead: this.hasHead, fresh: file.fresh, status: file.status, label: this.scopeLabel(), words: this.scopeWords() };
  }
  argvCtx(file) { return { home: appHome(), params: this.viewerProps(file) }; }

  // Opens a command in a tab, or (popup) as a peek over the current one. A popup needs a local terminal.
  show(file, argv, popup, cx) {
    const name = `diff · ${file.path.split("/").pop()}`;
    if (popup && !this.on) openPopup(this.root, argv, name, cx); else openTab(this.root, argv, name);
  }

  // The diff in the ion-diff viewer (native, with Ask): a tab, or (popup) a dialog over the current one.
  openDiff(file, popup) {
    if (!this.root) return;
    this.open = file.path;
    const props = { ...this.viewerProps(file), nvim: sideArgv(this.argvCtx(file)) };
    if (popup) openOverlay({ mod: "ion-diff", kind: "dialog", width: 0.9, height: 0.9, props });
    else run("tab.new", { name: `diff · ${file.path.split("/").pop()}`, mod: "ion-diff", props });
  }

  // The same diff side by side in Neovim (`u` there goes inline), in a tab or (popup) over the current one.
  nvimDiff(file, popup, cx) {
    if (this.root) this.show(file, sideArgv(this.argvCtx(file)), popup, cx);
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  setView(view, cx) { this.view = view; store.set("view", view); cx.notify(); }

  // The changed files as a folder tree.
  tree() {
    const root = { name: "", path: "", dirs: new Map(), files: [] };
    for (const f of this.files) {
      let node = root;
      for (const part of f.path.split("/").slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push(f);
    }
    return root;
  }

  // A folder with no files of its own and a single subfolder shows as one row ("a/b").
  fold(node) {
    let n = node, label = node.name;
    while (!n.files.length && n.dirs.size === 1) { n = n.dirs.values().next().value; label += `/${n.name}`; }
    return { n, label };
  }

  under(node) { return [...node.files, ...[...node.dirs.values()].flatMap((d) => this.under(d))]; }

  // The key of every folder row the tree shows, for Collapse all.
  dirKeys(node = this.tree(), keys = []) {
    for (const d of node.dirs.values()) { const { n } = this.fold(d); keys.push(n.path); this.dirKeys(n, keys); }
    return keys;
  }

  seg(t, options, current, pick) {
    return h_flex().flex_none().p(2).gap(2).rounded(8).bg(t.raised).children(options.map(([id, label]) =>
      div().id(`seg-${id}`).h(24).px(10).flex().items_center().rounded(6).text_size(12).cursor_pointer()
        .bg(current === id ? t.selected : "#00000000").text_color(current === id ? t.foreground : t.muted)
        .when(current === id, (e) => e.font_medium()).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => pick(id, cx)).child(label)));
  }

  // Subfolders first, then files, like Files. `depth` is how many folder levels sit above these entries.
  entries(node, depth, t) {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
    return [...dirs.flatMap((d) => this.dirNode(d, depth, t)), ...files.map((f) => this.row(f, t, depth))];
  }

  // One folder row, then what it holds indented under it with a guide line.
  dirNode(node, depth, t) {
    const { n, label } = this.fold(node), closed = this.collapsed.has(n.path), files = this.under(n);
    const add = files.reduce((s, f) => s + f.add, 0), del = files.reduce((s, f) => s + f.del, 0);
    const head = h_flex().id(`dir-${n.path}`).h(30).flex_none().pl(8 + depth * 18).pr(8).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { if (closed) this.collapsed.delete(n.path); else this.collapsed.add(n.path); cx.notify(); })
      .child(div().w(12).flex_none().text_size(10).text_color(t.dim).child(closed ? "▸" : "▾"))
      .child(image(iconFor(n.name, true, !closed)).size(18).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_size(13).child(label))
      .child(div().px(6).h(16).flex().items_center().rounded(8).bg(t.raised).text_size(10).text_color(t.dim).child(String(files.length)))
      .when(add > 0, (e) => e.child(div().text_size(10).text_color(t.ansi2).child(`+${add}`)))
      .when(del > 0, (e) => e.child(div().text_size(10).text_color(t.ansi1).child(`−${del}`)));
    if (closed) return [head];
    // The guide runs under this folder's icon: 8 padding + 12 arrow + 8 gap + half of the 18px icon, plus 18 per level.
    const guide = t.dim.length === 7 ? t.dim + "55" : t.dim;
    return [head, v_flex().flex_none().relative().children(this.entries(n, depth + 1, t))
      .child(div().absolute().left(37 + depth * 18).top(0).bottom(0).w(1).bg(guide))];
  }

  // `depth` undefined is the flat list (icon, name and folder); a number is a file under that many folders.
  row(f, t, depth) {
    const flat = depth === undefined, showPath = flat;
    const parts = f.path.split("/"), name = parts.pop();
    const color = f.status === "A" ? t.ansi2 : f.status === "M" ? t.blocked : t.ansi1;
    const gone = f.status === "D", hovered = this.hover === f.path;
    const small = (id, label, action) => div().id(id).h(20).px(8).flex().items_center().rounded(5).bg(t.raised).text_size(10.5).text_color(t.muted)
      .hover((s) => s.bg(t.selected).text_color(t.foreground)).on_click((ev, cx) => { cx.stop_propagation(); action(ev, cx); }).child(label);
    return h_flex().id(`change-${f.path}`).h(flat ? 38 : 30).flex_none().pl(flat ? 8 : 28 + depth * 18).pr(8).gap(9).items_center().rounded(7).cursor_pointer()
      .when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_hover((over, cx) => { if (over) this.hover = f.path; else if (this.hover === f.path) this.hover = null; cx.notify(); })
      .on_click((e) => this.openDiff(f, e.modifiers.shift))
      .child(image(iconFor(name, false, false)).size(showPath ? 20 : 17).flex_none())
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(12.5).when(gone, (e) => e.text_color(t.dim).line_through()).child(name))
        .when(showPath && parts.length > 0, (e) => e.child(div().truncate().text_size(10).text_color(t.dim).child(parts.join("/")))))
      .when(hovered, (e) => e
        .when(!gone, (e) => e.child(small(`open-${f.path}`, "open", (ev, cx) => this.openFile(f, ev.modifiers.shift, cx))))
        .child(small(`side-${f.path}`, "side-by-side", (ev, cx) => this.nvimDiff(f, ev.modifiers.shift, cx))))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
      .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(color).text_center().child(f.status));
  }

  // The scope picker: a select-looking box with the scope's name; a Popover lists the scopes the repo offers
  // and, under them, the recent commits (a click reviews that commit on its own).
  scopePicker(t) {
    const i = this.scopeInfo ?? {};
    const options = [
      { scope: "work", label: "Uncommitted", detail: "working tree vs HEAD", ok: true },
      { scope: "last", label: "Last commit", detail: i.last ? `${i.last}${i.subject ? ` · ${i.subject}` : ""}, plus uncommitted` : "HEAD has no parent", ok: Boolean(i.last) },
      { scope: "branch", label: i.base ? `vs ${i.base}` : "vs base branch", detail: i.merge ? `everything on ${i.branch} since it left ${i.base}` : i.base ? `on ${i.base} itself` : "no main or master branch", ok: Boolean(i.merge) },
    ];
    const box = h_flex().id("scope-box").h(22).px(8).gap(6).items_center().rounded(6).border_1().border_color(this.choosingScope ? t.accent : t.border).bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip("What is shown: the uncommitted changes, the last commit, the whole branch, or one commit")
      .child(div().text_size(11).truncate().child(this.scopeLabel())).child(div().text_size(9).text_color(t.dim).child("▾"));
    const check = (on) => div().w(12).text_size(11).text_color(t.accent).child(on ? "✓" : "");
    const commits = (this.log ?? []).map((c) =>
      h_flex().id(`scope-commit-${c.sha}`).px(10).py(5).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.setScope("commit", cx, c.sha)).tooltip(`${c.short} · ${c.author} · ${c.when}\n${c.subject}`)
        .child(div().flex_none().text_size(11).text_color(t.dim).child(c.short))
        .child(div().flex_1().min_w(0).text_size(12).truncate().child(c.subject))
        .child(div().flex_none().text_size(10).text_color(t.muted).child(c.when))
        .child(check(this.scope === "commit" && this.sha === c.sha)));
    return Popover.new("scope").open(this.choosingScope).on_open_change((open, cx) => { this.choosingScope = open; if (open) this.loadLog(cx); cx.notify(); })
      .trigger(box)
      .content(v_flex().mt(4).min_w(300).max_w(420).p(6).gap(2).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_md().children(options.map((o) =>
        h_flex().id(`scope-${o.scope}`).px(10).py(7).gap(10).items_center().rounded(6).when(o.ok, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.setScope(o.scope, cx))).when(!o.ok, (e) => e.opacity(0.5))
          .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(12).child(o.label)).child(div().text_size(11).text_color(t.dim).truncate().child(o.detail)))
          .child(check(o.scope === this.scope))))
        .child(div().mt(4).mx(4).border_t(1).border_color(t.border))
        .child(div().px(10).pt(6).pb(2).text_size(11).text_color(t.dim).truncate().child(i.merge ? `One commit on ${i.branch}, on its own` : "One commit, on its own"))
        .child(v_flex().id("scope-commits").max_h(280).overflow_y_scrollbar().gap(1)
          .when(this.log === null, (e) => e.child(div().px(10).py(5).text_size(11).text_color(t.dim).child("Loading commits…")))
          .when(this.log !== null && !commits.length, (e) => e.child(div().px(10).py(5).text_size(11).text_color(t.dim).child("No commits")))
          .children(commits)));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .when(Boolean(this.root) && this.hasHead, (e) => e.child(this.scopePicker(t)))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.seg(t, [["flat", "Flat"], ["folders", "Folders"]], this.view, (id, cx) => this.setView(id, cx)))
        .child(div().flex_1())
        .when(this.view === "folders" && this.files.length > 0, (e) => {
          const dirs = this.dirKeys(), all = dirs.length > 0 && dirs.every((d) => this.collapsed.has(d));
          if (!dirs.length) return e;
          return e.child(div().id("collapse-all").h(22).px(8).flex().items_center().rounded(6).text_size(11).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.collapsed = all ? new Set() : new Set(dirs); cx.notify(); }).child(all ? "Expand all" : "Collapse all"));
        }))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6)
          .children(this.view === "folders" ? this.entries(this.tree(), 0, t) : this.files.map((f) => this.row(f, t)))
          .when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? (this.scope === "work" ? "No uncommitted changes" : "No changes in this scope") : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
