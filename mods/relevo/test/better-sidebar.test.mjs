import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, find, flush, click, text } from "./fake/ui.mjs";
import { LAUNCHERS } from "./fake/config.mjs";

const { Agents } = await import("../../better-sidebar/views/agents.js");
const { Spaces } = await import("../../better-sidebar/views/spaces.js");
const { default: Relevo } = await import("../main.js");

beforeEach(() => { resetFake(); localStorage.removeItem("pins"); localStorage.removeItem("changed"); });
const ctx = () => /** @type {any} */ (fakeCx());
/** @param {string} address */
const a = (address, pinned = false) => ({ address, pinned, pane: `p-${address}`, tab: `tab-${address}`, space: "s1", space_name: "One", tab_name: address, status: "idle", seq: 1 });

test("legacy pins wait for core confirmation, including offline pins; shared pins and clicks use core", () => {
  localStorage.setItem("pins", JSON.stringify(["t1", "remote/t2"]));
  fake.agents = [a("t1"), a("t3", true)];
  fake.terminals = [{ address: "t1", state: "live", labels: {} }];
  const mod = new Agents(), cx = ctx(); mod.init({}, cx);
  let view = mod.render(); mod.render();
  assert.deepEqual(fake.runs.filter(([n]) => n === "terminal.pin"), [["terminal.pin", { terminal: "t1", pinned: true }]]);
  assert.deepEqual(JSON.parse(localStorage.getItem("pins")), ["t1", "remote/t2"]);
  assert.ok(text(view).indexOf("t3") < text(view).indexOf("t1"));
  fake.terminals[0].labels["herdr.pinned"] = "true";
  mod.hovered = "t3"; view = mod.render();
  assert.deepEqual(JSON.parse(localStorage.getItem("pins")), ["remote/t2"]);
  click(find(view, "pin-t3"), cx);
  assert.deepEqual(fake.runs.at(-1), ["terminal.pin", { terminal: "t3", pinned: false }]);
});

test("an unconfirmed migration never pins again on the timer, while offline pins remain pending", () => {
  localStorage.setItem("pins", JSON.stringify(["t1", "remote/t2"]));
  fake.agents = [a("t1")];
  fake.terminals = [{ address: "t1", state: "live", labels: {} }];
  const mod = new Agents(), cx = ctx(); mod.init({}, cx);
  mod.render();
  cx.fire(30000); mod.render();
  cx.fire(30000); mod.render();
  assert.deepEqual(fake.runs.filter(([name]) => name === "terminal.pin"), [["terminal.pin", { terminal: "t1", pinned: true }]]);
  assert.deepEqual(JSON.parse(localStorage.getItem("pins")), ["t1", "remote/t2"]);
  fake.terminals.push({ address: "remote/t2", state: "live", labels: {} });
  mod.render();
  assert.deepEqual(fake.runs.at(-1), ["terminal.pin", { terminal: "remote/t2", pinned: true }]);
});

test("account dot and background pill are visible, with Move only for local rows", () => {
  fake.stored["relevo.setup"] = { accounts: { work: { label: "Work", bg: "#123456" } } };
  fake.agents = [a("t1"), a("box/t2")];
  fake.terminals = fake.agents.map((agent) => ({ address: agent.address, state: "live", labels: { "agent.account": "work", "agent.bg": "⧗ 2 shells" } }));
  const mod = new Agents(), cx = ctx(); mod.init({}, cx);
  let ui = mod.render();
  assert.equal(text(find(ui, "acct-t1")), "");
  assert.match(find(ui, "acct-t1").tip, /Work account/);
  assert.equal(text(find(ui, "bg-t1")), "2");
  assert.match(find(ui, "bg-t1").tip, /2 shells/);
  mod.hovered = "t1"; ui = mod.render();
  let stopped = false; click(find(ui, "move-t1"), { ...cx, stop_propagation() { stopped = true; } });
  assert.ok(stopped); assert.equal(fake.runs.at(-1)[0], "relevo.handoff-agent-t1");
  mod.hovered = "box/t2"; assert.equal(find(mod.render(), "move-box/t2"), null);
  const nested = { ...mod.readView(), nested: true };
  assert.ok(find(mod.agentWithSubs(fake.agents[0], 0, nested, fakeTheme())[0], "bg-t1"));
});

test("space launch button stops row presses, captures the local space, and is absent on remote", async () => {
  const mod = new Spaces(), cx = ctx();
  mod.prObserver = /** @type {any} */ ({ entries: new Map() }); mod.git = {}; mod.pressed = null; mod.over = null;
  const local = { id: "s1", name: "One", tabs: /** @type {any[]} */ ([]), machine: /** @type {string | null} */ (null) }, remote = { id: "r/s2", name: "Remote", tabs: /** @type {any[]} */ ([]), machine: "r" };
  fake.spaces = [local, remote];
  mod.hoveredSpace = "s1";
  const row = mod.row({ w: local, i: 0, g: null, tree: null }, fakeTheme());
  const button = find(row, "space-launch-s1");
  let stops = 0; const eventCx = { ...cx, stop_propagation() { stops++; } };
  button.handlers["on_mouse_down:left"]({}, eventCx); button.handlers["on_mouse_up:left"]({}, eventCx); click(button, eventCx);
  assert.equal(stops, 3); assert.deepEqual(fake.runs, []);
  assert.equal(fake.overlays.at(-1).props.space, "s1");
  mod.hoveredSpace = remote.id;
  assert.equal(find(mod.row({ w: remote, i: 1, g: null, tree: "└─" }, fakeTheme()), `space-launch-${remote.id}`), null);
});

function fakeTheme() { return new Proxy({}, { get: (_t, k) => `#${String(k)}` }); }

test("the space launcher scrolls every configured profile even without shared setup", async () => {
  const local = { id: "s1", name: "One", tabs: /** @type {any[]} */ ([]), machine: /** @type {string | null} */ (null) };
  fake.spaces = [local];
  const spaces = new Spaces(), cx = ctx();
  click(spaces.launchButton(local, fakeTheme()), cx);
  const popup = fake.overlays.at(-1);
  assert.equal(popup.height, 360);
  const added = Array.from({ length: 15 }, (_, i) => ({ key: `extra-${i}`, label: `Extra ${i}`, app: "pi", profile: "test", command: "pi" }));
  LAUNCHERS.push(...added);
  try {
    fake.props = { ...popup.props, overlay: "popup" };
    const mod = new Relevo(); mod.init({}, cx); await flush();
    const list = find(mod.render(cx), "launcher-list");
    assert.equal(list.scrollable, true);
    assert.ok(find(list, "launch-profile-extra-14"));
    click(find(list, "launch-profile-extra-14"), cx);
    assert.equal(fake.runs.at(-1)[1].space, "s1");
  } finally { LAUNCHERS.splice(-added.length); }
});

test("a direct launch uses its captured space and refuses a space that became remote", async () => {
  fake.spaces = [{ id: "s1", machine: null }, { id: "s2", machine: null }];
  fake.focused = { cwd: "/other" };
  fake.props = { role: "launcher", space: "s1", overlay: "popup" };
  const mod = new Relevo(), cx = ctx(); mod.init({}, cx);
  assert.equal(find(mod.render(cx), "launch-profile-pi"), null, "waits for quota data");
  await flush();
  click(find(mod.render(cx), "launch-profile-pi"), cx);
  assert.equal(fake.runs.at(-1)[1].space, "s1");
  assert.equal(fake.runs.at(-1)[1].folder, undefined);
  fake.spaces[0].machine = "remote";
  fake.runs = [];
  click(find(mod.render(cx), "launch-profile-pi"), cx);
  assert.deepEqual(fake.runs, []);
});

test("launcher and quota fallback keep the captured space despite focus changes", async () => {
  fake.spaces = [{ id: "s1", machine: null }, { id: "s2", machine: null }];
  fake.focused = { cwd: "/other" };
  fake.stored["relevo.quota.api"] = { personal: { rate_limits: { five_hour: { used_percentage: 100 } } } };
  fake.props = { role: "launcher", space: "s1", overlay: "popup" };
  const mod = new Relevo(), cx = ctx(); mod.init({}, cx); await flush();
  click(find(mod.render(cx), "launch-profile-personal"), cx);
  const fallback = fake.overlays.at(-1);
  assert.equal(fallback.props.space, "s1");
  fake.focused = { cwd: "/changed" };
  fake.props = { ...fallback.props, overlay: "dialog" };
  const dialog = new Relevo(); dialog.init({}, cx);
  click(find(dialog.render(cx), "fallback-switch"), cx);
  assert.equal(fake.runs.at(-1)[0], "tab.new");
  assert.equal(fake.runs.at(-1)[1].space, "s1");
  assert.equal(fake.runs.at(-1)[1].folder, undefined);
});
