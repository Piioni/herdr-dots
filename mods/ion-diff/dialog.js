// Ask dialog: the viewer opened as an overlay of itself with props { dialog: true, title, context }.
// The note and the read-only context go to an agent of the current space as one `hc send`.
// Click the agent name to cycle through the agents of the space. Enter sends, Esc closes.
// Adapted from herdr-reviewer's send dialog (MIT, see NOTICE).
import { div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { agents, focused, hc, run, notify, props, closeOverlay, theme, settings } from "herdr";

export class Dialog {
  init(_props, cx) {
    const p = props() ?? {};
    this.context = String(p.context ?? ""); this.title = p.title ?? "";
    this.note = ""; this.pick = null; this.error = null; this.sending = false; this.confirm = false;
    this.input = TextareaState.new({ placeholder: "What do you want to ask?", rows: 3 });
    this.input.set_auto_grow(3, 6);
    this.input.on("change", (_e, cx) => { this.note = this.input.value(); this.error = null; this.confirm = false; cx.notify(); });
    this.input.on("submit", (e, cx) => { if (!e?.shift) this.send(cx); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  close() { closeOverlay(props().overlay); }

  candidates() { return agents().filter((a) => a.space === focused()?.space); }
  // The picked agent, else the focused one, else an idle one, else the first.
  target() {
    const list = this.candidates();
    return list.find((a) => a.address === this.pick) ?? list.find((a) => a.focused) ?? list.find((a) => a.status === "idle") ?? list[0] ?? null;
  }
  cycle(cx) {
    const list = this.candidates(), at = list.findIndex((a) => a.address === this.target()?.address);
    this.pick = list[(at + 1) % list.length]?.address ?? null; this.confirm = false; cx.notify();
  }

  send(cx) {
    const text = [this.note.trim(), this.context.trim()].filter(Boolean).join("\n\n"), agent = this.target();
    if (this.sending) return;
    if (!this.note.trim()) { this.error = "Type your question first"; cx.notify(); return; }
    if (!agent) { this.error = "No agent is running in this space. Start one first."; cx.notify(); return; }
    const busy = agent.status === "working" || agent.status === "blocked";
    if (busy && !this.confirm) { this.confirm = true; cx.notify(); return; }
    this.sending = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["send", ...(busy ? ["--force"] : []), agent.address, text]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      this.sending = false;
      if (r.code === 0) {
        this.close();
        notify({ title: `Sent to ${agent.program?.name ?? agent.app ?? agent.address}`, body: this.title, level: "success" });
        run("pane.focus", { terminal: agent.address });
      } else { this.error = (r.stderr || r.stdout).trim().slice(0, 300) || "hc send failed"; this.confirm = false; cx.notify(); }
    });
  }

  render(cx) {
    const t = theme(), agent = this.target(), count = this.candidates().length;
    const name = (a) => a.program?.name ?? a.app ?? a.address;
    const button = (id, text, primary, action, disabled) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .when(disabled, (e) => e.opacity(0.5)).when(!disabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action)).child(text);
    const lines = this.context.split("\n"), shown = lines.slice(0, 600);
    return v_flex().id("ask-agent").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); cx.stop_propagation(); }
        else if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) { this.send(cx); cx.stop_propagation(); }
      })
      .size_full().min_h(0).p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().items_center().gap(8)
        .child(div().text_size(15).font_semibold().child("Ask the agent"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.title)))
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(11.5).text_color(t.dim).child("To"))
        .child(agent
          ? h_flex().id("to-box").h(28).px(9).gap(7).items_center().rounded(7).border_1().border_color(t.input).bg(t.raised)
              .when(count > 1, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Click to switch agent").on_click((_e, cx) => this.cycle(cx)))
              .child(div().size(7).rounded(4).bg(t[agent.status] ?? t.unknown))
              .child(div().text_size(12).child(`${name(agent)} · ${agent.tab_name}`))
              .child(div().text_size(10.5).text_color(t.dim).child(agent.status))
          : div().text_size(12).text_color(t.muted).child("No agent is running in this space")))
      .child(Textarea.new(this.input).w_full().px(10).py(8).rounded(9).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(v_flex().flex_1().min_h(100).gap(4)
        .child(div().text_size(11).text_color(t.dim).child(`Sent after your question · ${lines.length} lines · read-only`))
        .child(div().id("ask-context-x").flex_1().min_h(0).rounded(8).border_1().border_color(t.border).bg(t.background).overflow_x_scrollbar()
          .child(v_flex().id("ask-context").h_full().min_w(Math.max(0, ...shown.map((l) => l.length)) * 6.7 + 24).overflow_y_scrollbar().p(8)
            .font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.muted).whitespace_nowrap()
            .children(shown.map((l) => div().h(16).flex_none().child(l || " ")))
            .when(lines.length > shown.length, (e) => e.child(div().text_color(t.dim).child(`… ${lines.length - shown.length} more lines are sent too`))))))
      .when(this.context.length > 8000, (e) => e.child(div().text_size(11).text_color(t.blocked).whitespace_normal().child(`${(this.context.length / 1024).toFixed(0)} KB is pasted into the agent's terminal; some agents are slow or cut it short at this size.`)))
      .when(Boolean(this.error), (e) => e.child(div().text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(this.confirm ? t.blocked : t.dim)
          .child(this.confirm && agent ? `${name(agent)} is ${agent.status}. Send anyway? The text is typed into its input now.` : "cmd-enter sends · one message"))
        .child(button("ask-cancel", "Cancel", false, () => this.close()))
        .child(button("ask-send", this.sending ? "Sending…" : this.confirm ? "Send anyway" : "Send", true, (_e, cx) => this.send(cx), this.sending)));
  }
}
