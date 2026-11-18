import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, run, layout, theme, notify, props, shared, setShared, openOverlay } from "herdr";
import { normalize, counts, shown, grouped, stacked, nest, lead, nameList, IMPLIED, SCOPES, CHIPS } from "./model.js";
import { avatar } from "./people.js";
import { shown as handle } from "./timeline.js";
import { icons, icon } from "./icons.js";
import { Viewer } from "./viewer.js";
import { Menu, openMenu } from "./menu.js";

const REFRESH = 60000;
const BASIC = "number,title,url,author,assignees,isDraft,labels,updatedAt,isCrossRepository,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles";
// What the open list needs to judge a PR; merged and closed ones are only listed, so they skip the heavy review, comment and check data.
const FIELDS = { open: `${BASIC},reviewRequests,latestReviews,comments,mergeable,mergeStateStatus,reviewDecision`, merged: BASIC, closed: BASIC };
// A change of focus or panel re-uses a list this young instead of asking GitHub again.
const FRESH = 15000;
// How long a folder found outside any repo is not asked about again.
const MISS = 600000;
// Open lists kept between runs, for the most recently refreshed repos.
const KEPT = 3;
const STATES = { open: { label: "Open", limit: 100 }, stacked: { label: "Stacked" }, merged: { label: "Merged", limit: 40 }, closed: { label: "Closed", limit: 30 } };
// Stacked is a view of the open list, not a list of its own.
const src = (state) => (state === "stacked" ? "open" : state);
// In a stack: on another PR, carrying one, or aimed at a branch other than the trunk.
const inStack = (prs) => { const parents = new Set(prs.map((p) => p.parent)); return (p) => p.parent || parents.has(p.number) || p.offTrunk; };
// Each row signal: words, tone, glyph and tooltip (see signals() in model.js; "since" is worded per PR).
const SIGNAL = {
  conflicts: ["Conflicts", "ansi1", "alert", "Conflicts with the base branch"],
  changes: ["Changes requested", "ansi1", "x"],
  blocked: ["Blocked", "ansi3", "alert", "Approved, but GitHub still blocks the merge: required checks or reviews are missing"],
  behind: ["Behind", "ansi3", "behind", "Behind its base branch"],
  approved: ["Approved", "ansi2", "check"],
  needs: ["Needs review", "ansi3", "eye"],
  draft: ["Draft", "muted", "draft"],
  "merge-clean": ["Merges cleanly", "dim", "merged"],
  "merge-unknown": ["Checking mergeability", "dim", "dot"],
};
const CHIP_TONES = { conflicts: "ansi1", changes: "ansi1", approved: "ansi2", needs: "ansi3", reviewing: "ansi4", reviewed: "ansi6", asked: "accent", draft: "muted" };
const SECTION_TONES = { attention: "ansi1", ready: "ansi2", waiting: "ansi3", draft: "muted", needs: "ansi3", reviewing: "ansi4", reviewed: "ansi6", changes: "ansi1", approved: "ansi2" };
const LAST = { changes: ["requested changes", "ansi1"], approved: ["approved", "ansi2"], reviewed: ["reviewed", "ansi4"], comment: ["commented", "ansi4"] };
// Where each reviewer stands: glyph, tone and what the tooltip says.
const VERDICT = { changes: ["x", "ansi1", "requested changes"], approved: ["check", "ansi2", "approved"], reviewed: ["comment", "ansi4", "commented"], pending: ["eye", "muted", "asked to review"] };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const hit = find(child, id); if (hit) return hit; }
  return null;
}

// `gh pr list` returns every review's commit as empty, so ask GraphQL which commit each verdict was left on,
// plus the last commits of each PR (oldest first) to count what was pushed since a review.
// Best effort: on failure reviews keep no commit and are treated as current. Returns why it failed, or null.
async function reviewCommits(repo, raw, on) {
  const [owner, name] = repo.split("/");
  const query = `query($o:String!,$n:String!){repository(owner:$o,name:$n){pullRequests(states:OPEN,first:100,orderBy:{field:CREATED_AT,direction:DESC}){nodes{number latestReviews(first:30){nodes{author{login} commit{oid}}} commits(last:30){nodes{commit{oid parents{totalCount}}}}}}}}`;
  try {
    const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`, "-f", `o=${owner}`, "-f", `n=${name}`], { on });
    if (r.code !== 0) return (r.stderr || r.stdout).trim().split("\n")[0] || "gh failed";
    const oids = new Map(), tails = new Map(), merges = new Map();
    for (const p of JSON.parse(r.stdout).data.repository.pullRequests.nodes) {
      tails.set(p.number, p.commits.nodes.map((n) => n.commit.oid));
      merges.set(p.number, p.commits.nodes.filter((n) => n.commit.parents.totalCount > 1).map((n) => n.commit.oid));
      for (const v of p.latestReviews.nodes) oids.set(`${p.number}:${v.author?.login}`, v.commit?.oid);
    }
    for (const p of raw) {
      p.recentCommits = tails.get(p.number) ?? [];
      p.mergeOids = merges.get(p.number) ?? [];
      for (const v of p.latestReviews ?? []) v.commit = { oid: oids.get(`${p.number}:${v.author?.login}`) ?? v.commit?.oid };
    }
    return null;
  } catch (e) { return String(e); }
}

// The PR dialog beats while open (see Viewer): the list behind it has no reason to change.
const dialogOpen = () => Date.now() - Number(shared("prs.dialog") ?? 0) < 75000;
const idle = () => hidden() || dialogOpen();

// Nothing to fetch while another panel (or none) is showing.
function hidden() {
  const root = layout(), body = find(root, "panel-body");
  return find(root, "panel")?.hidden || find(body, body?.active)?.content?.mod !== "prs";
}

// Where the focused pane is, as the Changes panel finds it. A focused mod pane keeps the last one.
function location(last) {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && !pane.terminal && last) return last;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

const remembered = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const keep = (key, value) => localStorage.setItem(key, JSON.stringify(value));

function age(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  if (s < 60 * 86400) return `${Math.floor(s / (7 * 86400))}w`;
  return `${Math.floor(s / (30 * 86400))}mo`;
}

export default class Prs extends View {
  init(_props, cx) {
    const { pr, overlay, button, menu } = props() ?? {};
    if (menu) { this.menu = new Menu(menu, overlay, cx); return; }
    if (pr) { this.viewer = new Viewer(pr, overlay, cx); return; }
    if (button) {
      const panels = shared("workspace.panels") ?? ["files", "changes"];
      if (!panels.includes("prs")) setShared("workspace.panels", [...panels, "prs"]);
      this.button = true;
      cx.spawn(async (cx) => { await icons(); this.icons = true; cx.notify(); });
      return;
    }
    this.scope = SCOPES[remembered("scope")] ? remembered("scope") : "all";
    this.state = STATES[remembered("state")] ? remembered("state") : "open";
    this.query = "";
    this.fold = new Set(remembered("fold", []));
    // Open view: show PRs that sit on another PR, or leave them to the Stacked tab.
    this.showStacked = remembered("showStacked", true);
    // repo -> state -> { prs, at }. Open lists are kept between runs so the panel shows them at once while the fresh ones load.
    this.lists = remembered("lists", {});
    // A pinned repo is shown whatever the focus: { repo, on }.
    this.pinned = remembered("pinned", null);
    this.repos = remembered("repos", {}); this.logins = remembered("logins", {}); this.spaceRepos = remembered("spaces", {});
    this.repo = null; this.last = null; this.errors = {}; this.misses = {};
    this.input = InputState.new({ placeholder: "Filter pull requests" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    cx.spawn(async (cx) => { await icons(); this.icons = true; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(REFRESH, (cx) => { if (!idle()) this.refresh(cx); });
    // A change made in the dialog shows in the list within a few seconds of closing it.
    cx.timer.every(3000, (cx) => {
      const changed = shared("prs.changed")?.at;
      const gone = idle();
      if (changed && changed !== this.changedAt) { this.changedAt = changed; this.stale = true; }
      if (!gone && this.stale) { this.stale = false; this.refresh(cx); }
      else if (!gone && (this.gone || this.context() !== this.ctx)) this.refresh(cx, this.state, FRESH);
      this.gone = gone;
    });
  }

  close() { this.viewer?.close(); }

  where() { return (this.last = location(this.last)); }
  context() { return JSON.stringify([this.where(), focused()?.space]); }

  // A folder outside any repo is remembered as a miss for a while, so it isn't asked again on every refresh.
  async repoFor(cwd, on) {
    const id = JSON.stringify([cwd, on]);
    if (!this.repos[id] && !(Date.now() - (this.misses[id] ?? 0) < MISS)) {
      const r = await exec("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd, on });
      if (r.code === 0) { this.repos[id] = r.stdout.trim(); keep("repos", this.repos); } else this.misses[id] = Date.now();
    }
    return this.repos[id] ?? null;
  }

  async login(on) {
    const id = on ?? "";
    if (!this.logins[id]) {
      const r = await exec("gh", ["api", "user", "-q", ".login"], { on });
      if (r.code === 0) { this.logins[id] = r.stdout.trim(); keep("logins", this.logins); }
    }
    return this.logins[id];
  }

  // Each space keeps the repo its own terminals were last in: a folder outside any repo keeps it.
  pick(found, space, on) {
    if (this.pinned) { this.repo = this.pinned.repo; this.repoOn = this.pinned.on; return; }
    if (found) { this.spaceRepos[space] = { repo: found, on }; keep("spaces", this.spaceRepos); }
    const s = spaces().find((x) => x.id === space), tabs = new Set(s?.tabs.map((tab) => tab.id) ?? []);
    const guess = panes().map((p) => (tabs.has(p.tab) && p.cwd ? this.repos[JSON.stringify([p.cwd, s?.machine ?? null])] : null)).find(Boolean);
    const choice = this.spaceRepos[space] ?? (guess ? { repo: guess, on: s?.machine ?? null } : null);
    this.repo = choice?.repo ?? null; this.repoOn = choice?.on ?? null;
  }

  // maxAge: keep a list younger than this (ms) instead of fetching it again; 0 always fetches.
  refresh(cx, state = this.state, maxAge = 0) {
    state = src(state);
    const { cwd, on } = this.where(), context = this.context(), space = focused()?.space;
    if (context !== this.ctx) { this.ctx = context; this.errors = {}; this.pick(cwd ? this.repos[JSON.stringify([cwd, on])] : null, space, on); }
    if (this.syncing) { this.again = true; return; }
    this.syncing = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const found = cwd ? await this.repoFor(cwd, on) : null;
        // The focus moved while gh answered: this fetch is for a place no longer shown; the queued refresh takes over.
        if (this.ctx !== context) { this.again = true; return; }
        this.pick(found, space, on);
        const repo = this.repo;
        if (!repo) return;
        const have = this.lists[repo]?.[state];
        if (have && Date.now() - have.at < maxAge) { delete this.errors[state]; return; }
        this.me = await this.login(this.repoOn);
        const r = await exec("gh", ["pr", "list", "-R", repo, "--state", state, "--limit", String(STATES[state].limit), "--json", FIELDS[state]], { on: this.repoOn });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0]);
        const raw = JSON.parse(r.stdout);
        if (state === "open") this.notice = await reviewCommits(repo, raw, this.repoOn);
        (this.lists[repo] ??= {})[state] = { prs: (state === "open" ? stacked : (x) => x)(raw.map((p) => normalize(p, state))), at: Date.now() };
        keep("lists", Object.fromEntries(Object.entries(this.lists).filter(([, v]) => v.open).sort(([, a], [, b]) => b.open.at - a.open.at).slice(0, KEPT).map(([k, v]) => [k, { open: v.open }])));
        delete this.errors[state];
      } catch (e) { if (this.ctx === context) this.errors[state] = String(e?.message ?? e); }
      finally {
        this.syncing = false; cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  // Pin the repo on screen, or release it to follow the focus again.
  togglePin(cx) {
    this.pinned = this.pinned ? null : { repo: this.repo, on: this.repoOn ?? null };
    keep("pinned", this.pinned);
    this.refresh(cx);
  }

  // The chosen filter lives in shared state: the popup that picks it is another copy of this mod.
  chipOf() { const k = (shared("prs.chip") ?? {})[this.scope]; return CHIPS[this.scope][k] ? k : "all"; }

  toolbar(t) {
    const root = layout(), panel = find(root, "panel"), on = panel && !panel.hidden && find(root, "panel-body")?.active === "prs";
    return h_flex().size_full().pr(4).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("panel-prs").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: "prs" }); run("layout.show", { id: "panel" }); }
        })
        .child(div().size(14).when(this.icons, (e) => e.child(svg(icon("open")).size(14)))).child("PRs"));
  }

  // A tab of the header: the active one is underlined with the accent.
  tab(id, t, on, onClick, ...kids) {
    return h_flex().id(id).h_full().px(8).gap(6).flex_none().items_center().text_size(13).cursor_pointer()
      .border_b(2).border_color(on ? t.accent : "#00000000").text_color(on ? t.foreground : t.muted).when(on, (e) => e.font_semibold())
      .hover((s) => s.text_color(t.foreground)).on_click(onClick).children(kids.filter(Boolean));
  }

  // One side of the All/Mine switch: the chosen one lifts off the track.
  scopeTab(key, label, on, count, t, onClick) {
    return h_flex().id(`scope-${key}`).h(24).px(10).gap(5).items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(on ? t.selected : "#00000000").text_color(on ? t.foreground : t.muted).when(on, (e) => e.font_medium())
      .hover((s) => s.text_color(t.foreground)).on_click(onClick)
      .child(label).when(count !== null, (e) => e.child(div().text_size(11).font_normal().text_color(t.dim).child(String(count))));
  }

  // Show or hide the PRs stacked on another PR in the Open view.
  stackToggle(t) {
    const on = this.showStacked;
    return h_flex().id("prs-stacked-toggle").h(24).px(8).gap(6).flex_none().items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(on ? `${t.ansi5}24` : "#00000000").text_color(on ? t.ansi5 : t.muted).border_1().border_color(on ? `${t.ansi5}66` : t.border)
      .hover((s) => s.text_color(on ? t.ansi5 : t.foreground)).tooltip(on ? "Hide PRs stacked on another PR" : "Show PRs stacked on another PR")
      .on_click((_e, cx) => { this.showStacked = !on; keep("showStacked", this.showStacked); cx.notify(); })
      .child(div().size(12).flex_none().when(this.icons, (e) => e.child(svg(icon("stack")).size(12))))
      .child("Stacked");
  }

  // One button for every filter: it names the active one and opens the list in a popup.
  filterView(chip, c, chips, t) {
    const on = chip !== "all", label = CHIPS[this.scope][chip].label, tone = CHIP_TONES[chip], cur = shared("prs.chip") ?? {};
    const items = [["all", CHIPS[this.scope].all], ...chips].map(([k, ch]) => ({
      label: ch.label, count: c[k], dot: CHIP_TONES[k], checked: chip === k, h: 32, shared: ["prs.chip", { ...cur, [this.scope]: k }],
    }));
    return h_flex().id("prs-chip").h(24).px(8).gap(6).flex_none().items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(on ? t.selected : "#00000000").text_color(on ? t.foreground : t.muted).when(on, (e) => e.font_medium())
      .hover((s) => s.bg(on ? t.selected : t.hover).text_color(t.foreground)).on_click(() => openMenu(items, 240))
      .when(on && Boolean(tone), (e) => e.child(div().size(6).flex_none().rounded(3).bg(t[tone])))
      .child(on ? label : "Filter").when(on, (e) => e.child(div().text_size(11).font_normal().text_color(t.dim).child(String(c[chip]))))
      .child(div().size(10).flex_none().when(this.icons, (e) => e.child(svg(icon("chev-d")).size(10))));
  }

  // A status: a loud tinted capsule when it needs a look, a quiet glyph and word when it's the expected case.
  tag(id, t, color, label, glyph, tip, quiet = false) {
    return h_flex().id(id).h(20).gap(4).flex_none().items_center().text_size(11).font_medium().text_color(quiet ? t.muted : color)
      .when(!quiet, (e) => e.px(7).rounded(10).bg(color === t.muted ? t.raised : `${color}24`))
      .when(Boolean(tip), (e) => e.tooltip(tip))
      .when(Boolean(glyph) && this.icons, (e) => e.child(svg(icon(glyph)).size(11).text_color(color))).child(label);
  }

  // implied: the review state the row's section already says (IMPLIED), left out of the row.
  // nested: the row hangs under its parent, so the elbow already says what the stack chip would.
  // Line 2: the most urgent signal in words, the others as icons, the stack chip; people and size on the right.
  row(p, t, cx, implied = null, nested = false) {
    const open = p.state === "open";
    const cut = (s) => (s.length > 26 ? `${s.slice(0, 25)}…` : s);
    const { primary, rest } = lead(p, implied);
    const sig = (k) => {
      if (k !== "since") return SIGNAL[k];
      const parts = [p.since.commits && plural(p.since.commits, "new commit"), p.since.replies && (p.since.replies === 1 ? "1 reply" : `${p.since.replies} replies`)].filter(Boolean);
      return [parts.join(" · "), "ansi4", p.since.commits ? "commit" : "comment", `Since ${handle(p.since.login)}'s last review: ${parts.join(" and ")}`];
    };
    const capsule = [];
    // Only Blocked needs its tooltip: the other capsules say it all.
    if (primary) { const [label, tone, glyph, tip] = sig(primary); capsule.push(this.tag(`sg-${p.number}`, t, t[tone], label, glyph, primary === "blocked" ? tip : null)); }
    if (!open) capsule.push(this.tag(`st-${p.number}`, t, p.state === "merged" ? t.ansi5 : t.ansi1, p.state === "merged" ? "Merged" : "Closed", p.state === "merged" ? "merged" : "closed"));
    const glyphs = rest.map((k) => {
      const [label, tone, glyph, tip] = sig(k);
      return div().id(`si-${p.number}-${k}`).flex_none().tooltip(tip ?? label).when(this.icons, (e) => e.child(svg(icon(glyph)).size(12).text_color(t[tone])));
    });
    const stack = p.parent && !nested ? this.tag(`sk-${p.number}`, t, t.ansi5, `on #${p.parent}`, "stack", `Stacked on #${p.parent} ${p.parentTitle}\n${p.head} → ${p.base}`)
      : !p.parent && p.offTrunk ? this.tag(`sk-${p.number}`, t, t.ansi5, `→ ${cut(p.base)}`, "branch", `Targets ${p.base}, not ${p.trunk}`) : null;
    const last = open && p.last ? p.last : null, [verb, lastTone] = LAST[last?.kind] ?? [];
    const quiet = open && !p.draft ? t.foreground : t.muted;
    return v_flex().id(`pr-${p.number}`).flex_none().min_w(0).px(10).py(9).gap(7).rounded(8).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => this.open(p))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation(); cx.write_to_clipboard(p.head);
        notify({ title: "Branch copied", body: p.head, level: "success", timeout: 2500 });
      })
      .child(h_flex().gap(10).items_start().min_w(0)
        .child(div().pt(1).child(avatar(p.author, null, 28, t, cx)))
        .child(v_flex().flex_1().min_w(0).gap(5)
          .child(h_flex().gap(6).items_center().min_w(0)
            .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(quiet).child(p.title))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${p.number} · ${age(p.updatedAt)}`)))
          .child(h_flex().gap_x(8).gap_y(5).items_center().flex_wrap().min_w(0).text_size(11)
            // Who it is (in All) or which branch (in Mine): many avatars are GitHub's default picture.
            .child(div().flex_none().max_w(200).truncate().text_color(t.muted).child(this.scope === "mine" ? p.head : handle(p.author)))
            .children(capsule)
            .when(glyphs.length > 0, (e) => e.child(h_flex().gap(6).flex_none().items_center().children(glyphs)))
            .when(Boolean(stack), (e) => e.child(stack))
            .child(div().flex_1())
            .when(open, (e) => e.child(this.people(p, t, cx)))
            .child(h_flex().gap(4).flex_none().ml(4).child(div().text_color(t.ansi2).child(`+${p.adds}`)).child(div().text_color(t.ansi1).child(`−${p.dels}`))))
          .when(Boolean(last), (e) => e.child(h_flex().gap(6).items_center().min_w(0).mt(1).px(8).py(4).rounded(6).bg(t.raised).text_size(11)
            .child(avatar(last.login, null, 14, t, cx))
            .child(div().flex_none().font_medium().text_color(t[lastTone]).child(`${handle(last.login)} ${verb}`))
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(last.text))
            .child(div().flex_none().text_color(t.dim).child(age(last.at)))))));
  }

  // Who is reviewing now (blue), who was asked and hasn't answered (grey), then a segmented bar of the verdicts given:
  // one segment per reviewer who answered, colored by verdict, grey when it was left on an older commit (it no longer counts).
  people(p, t, cx) {
    const ORDER = { approved: 0, reviewed: 1, changes: 2 };
    const answered = p.verdicts.filter((v) => v.kind !== "pending").sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
    const asked = p.verdicts.filter((v) => v.kind === "pending" && !p.assignees.includes(v.login)).map((v) => v.login);
    const approved = answered.filter((v) => v.kind === "approved" && !v.stale).length;
    // Avatars, then a word that never shrinks and names that cut first.
    const capsule = (id, logins, word, color, bg) => h_flex().id(id).h(20).pl(3).pr(7).gap(5).flex_none().items_center().rounded(10).bg(bg).text_color(color).font_medium()
      .child(h_flex().gap(2).flex_none().items_center().children(logins.slice(0, 3).map((a) => avatar(a, null, 14, t, cx))))
      .child(div().flex_none().child(`${word} ·`))
      .child(div().min_w(0).max_w(110).truncate().child(nameList(logins.map(handle))));
    const bar = answered.length
      ? h_flex().id(`rb-${p.number}`).gap(6).flex_none().items_center()
        .tooltip(answered.map((v) => `${handle(v.login)}: ${VERDICT[v.kind][2]}${v.stale ? " on an older commit" : ""}`).join("\n"))
        .child(h_flex().gap(2).items_center().children(answered.map((v) => div().w(10).h(5).rounded(2).bg(v.stale ? t.border : t[VERDICT[v.kind][1]]))))
        .child(div().text_color(t.dim).child(`${approved}/${answered.length}`))
      : null;
    return h_flex().flex_none().gap(8).items_center()
      .when(p.assignees.length > 0, (e) => e.child(capsule(`rw-${p.number}`, p.assignees, "Reviewing", t.ansi4, `${t.ansi4}24`)))
      .when(asked.length > 0, (e) => e.child(capsule(`ak-${p.number}`, asked, "Asked", t.muted, t.raised)))
      .when(Boolean(bar), (e) => e.child(bar));
  }

  // A section header, folded or unfolded by a click, like the groups of the Issues panel.
  section(key, tone, label, count, closed, t, first) {
    return h_flex().id(`section-${key}`).h(30).flex_none().px(8).gap(8).items_center().rounded(7).bg(t.raised).cursor_pointer().mt(first ? 0 : 8)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { if (this.fold.has(key)) this.fold.delete(key); else this.fold.add(key); keep("fold", [...this.fold]); cx.notify(); })
      .child(div().size(12).flex_none().when(this.icons, (e) => e.child(svg(icon(closed ? "chev-r" : "chev-d")).size(12).text_color(t.dim))))
      .child(div().size(8).flex_none().rounded(4).bg(t[tone]))
      .child(div().font_semibold().text_size(12).child(label))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(t.dim).child(String(count)));
  }

  // Rows with a hairline between them; a stacked PR hangs under its parent on an elbow.
  rows(prs, t, cx, implied) {
    return nest(prs).flatMap(({ p, depth }, i) => [
      ...(i && !depth ? [div().h(1).flex_none().mx(10).bg(t.border).opacity(0.5)] : []),
      depth ? h_flex().flex_none().min_w(0).items_start()
        .child(div().flex_none().ml(23 + 26 * (depth - 1)).w(13).h(24).border_l(2).border_b(2).border_color(`${t.ansi5}99`).rounded_bl(8))
        .child(div().flex_1().min_w(0).child(this.row(p, t, cx, implied, true)))
        : this.row(p, t, cx, implied),
    ]);
  }

  // cwd only when the focused folder is a clone of this very repo: the dialog reads conflicts from it. seed: what the row already knows, so the dialog's header draws at once.
  open(p) {
    const { cwd, on } = this.where(), clone = cwd && this.repos[JSON.stringify([cwd, on])] === this.repo ? cwd : null;
    const seed = { title: p.title, author: p.author, head: p.head, base: p.base, draft: p.draft, adds: p.adds, dels: p.dels, merge: p.merge, state: p.state };
    openOverlay({ mod: "prs", kind: "dialog", width: 0.86, height: 0.9, props: { pr: { repo: this.repo, number: p.number, on: this.repoOn ?? null, me: this.me, cwd: clone, seed } } });
  }

  render(cx) {
    if (this.viewer) return this.viewer.render(cx);
    if (this.menu) return this.menu.render();
    const t = theme();
    if (this.button) return this.toolbar(t);
    const shell = v_flex().id("prs").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    if (!this.repo) return shell.child(v_flex().flex_1().items_center().justify_center().gap(10).px(36)
      .child(div().size(28).when(this.icons, (e) => e.child(svg(icon("open")).size(28).text_color(t.dim))))
      .child(div().font_semibold().text_color(t.muted).child(this.syncing ? "Looking for a repository…" : "No repository yet"))
      .child(div().text_size(12).text_color(t.dim).text_center().child("Focus a terminal inside a GitHub repository and its pull requests show up here.")));
    const error = this.errors[src(this.state)] ?? null;
    const entry = this.lists[this.repo]?.[src(this.state)], prs = entry?.prs ?? [], stack = this.state === "stacked";
    const chip = this.state === "open" ? this.chipOf() : "all", c = counts(prs, this.scope, this.me);
    // Drafts (and, with the toggle off, stacked PRs) stay out of the default list; a chip or a search brings them in.
    const noDrafts = chip === "all" && !this.query.trim() && !stack, stacks = inStack(prs);
    // The Stacked view keeps drafts: a stack's lower PRs are often drafts waiting on the one below.
    const list = shown(prs, { scope: this.scope, chip, query: this.query, me: this.me }).filter((p) => (stack ? stacks(p) : !noDrafts || (!p.draft && (this.showStacked || !p.parent))));
    // Sections only while nothing narrows the list: a chip or a search already is the grouping.
    const sections = this.state === "open" && chip === "all" && !this.query.trim() && list.length ? grouped(list, this.scope) : null;
    const empty = error ?? (!entry ? "Loading pull requests…" : this.query.trim() ? "No pull requests match" : stack ? "No stacked pull requests" : "Nothing here");
    // Tab counts are repo totals; the All/Mine pills split what the current view counts.
    const open = this.lists[this.repo]?.open?.prs;
    const tabCounts = open ? { open: open.filter((p) => !p.draft).length, stacked: open.filter(inStack(open)).length } : {};
    const live = stack ? prs.filter(stacks) : prs.filter((p) => !p.draft), mineCount = live.filter((p) => p.author === this.me).length;
    const pickState = (k) => (_e, cx) => {
      this.state = k; keep("state", k);
      if (!this.lists[this.repo]?.[src(k)]) this.refresh(cx, k);
      cx.notify();
    };
    // Clicking the active chip clears it, so there's no "All" chip to carry.
    const chips = this.state === "open" ? Object.entries(CHIPS[this.scope]).filter(([k]) => k !== "all" && (k === chip || c[k] > 0)) : [];
    return shell
      .child(h_flex().h(42).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(h_flex().h_full().flex_none().min_w(0).gap(2)
          .children(Object.entries(STATES).map(([k, s]) => this.tab(`state-${k}`, t, this.state === k, pickState(k),
            s.label, tabCounts[k] !== undefined ? div().text_size(11).font_normal().text_color(t.dim).child(String(tabCounts[k])) : null))))
        .child(div().flex_1())
        .child(h_flex().id("prs-filter").w(150).min_w(70).h(28).px(8).gap(6).items_center().rounded(7).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(div().size(12).flex_none().when(this.icons, (e) => e.child(svg(icon("search")).size(12).text_color(t.dim))))
          .child(Input.new(this.input).h_full().flex_1().min_w(0).text_size(12).text_color(t.foreground)))
        .child(div().id("prs-pin").size(28).flex_none().flex().items_center().justify_center().rounded(7).border_1().border_color(this.pinned ? t.accent : t.border).text_color(this.pinned ? t.accent : t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.togglePin(cx))
          .tooltip(this.pinned ? `Unpin ${this.repo}` : `Pin ${this.repo}: keep showing it when the focus moves elsewhere`)
          .child(div().size(12).when(this.icons, (e) => e.child(svg(icon("pin")).size(12)))))
        .child(div().id("prs-refresh").size(28).flex_none().flex().items_center().justify_center().rounded(7).border_1().border_color(t.border).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.misses = {}; this.refresh(cx); })
          .tooltip(`${this.repo}${entry ? ` · updated ${age(new Date(entry.at).toISOString())} ago` : ""}`)
          .child(this.syncing
            ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)
            : div().size(12).when(this.icons, (e) => e.child(svg(icon("refresh")).size(12))))))
      .child(h_flex().flex_none().px(10).py(8).gap(10).items_center().border_b(1).border_color(t.border)
        .child(h_flex().flex_none().p(2).gap(2).rounded(8).bg(t.raised)
          .children(Object.entries(SCOPES).map(([k, label]) => this.scopeTab(k, label, this.scope === k, entry ? (k === "mine" ? mineCount : live.length) : null, t,
            (_e, cx) => { this.scope = k; keep("scope", k); cx.notify(); }))))
        .when(chips.length > 0, (e) => e.child(this.filterView(chip, c, chips, t)))
        .when(this.state === "open", (e) => e.child(div().flex_1()).child(this.stackToggle(t))))
      .when(Boolean(this.notice && src(this.state) === "open" && !error), (e) => e.child(div().flex_none().px(14).py(4).text_size(11).text_color(t.ansi3).border_b(1).border_color(t.border).truncate()
        .tooltip(this.notice).child("Couldn't read review commits: reviews on older commits may still count")))
      .when(Boolean(error && entry), (e) => e.child(div().flex_none().px(14).py(6).text_size(11).text_color(t.ansi1).border_b(1).border_color(t.border).truncate().child(error)))
      .child(v_flex().id("prs-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .children(sections
          ? sections.flatMap((g, i) => {
            const key = `${this.scope}|${g.key}`, closed = this.fold.has(key);
            // The section already says "needs review", "approved" or "draft"; "Needs your attention" mixes states, so its rows keep theirs.
            return [this.section(key, SECTION_TONES[g.key], g.label, g.prs.length, closed, t, i === 0), ...(closed ? [] : this.rows(g.prs, t, cx, IMPLIED[this.scope][g.key] ?? null))];
          })
          : this.rows(list, t, cx, null))
        .when(!list.length, (e) => e.child(div().px(16).py(28).text_size(12).text_center().text_color(error ? t.ansi1 : t.dim).child(empty))));
  }
}
