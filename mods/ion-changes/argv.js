// The command that opens a file's diff side by side in Neovim. Pure, so it can be tested.
// `params` travel in ION_DIFF_PARAMS: the `u` key (swap.lua, which builds this same command) opens the inline view from them.
const params = (p) => `ION_DIFF_PARAMS=${JSON.stringify(p)}`;

/** Neovim's side-by-side diff through git difftool (diff.lua). New (untracked) files have nothing to compare against: read-only. */
export function sideArgv({ home, params: p }) {
  const env = ["env", `VIMINIT=source ${home}/mods/ion-changes/diff.lua`, params(p)];
  return p.fresh || (!p.hasHead && p.status === "A")
    ? [...env, "nvim", "-R", p.path]
    : [...env, "git", "-c", "diff.tool=nvimdiff", "difftool", "-y", ...(p.hasHead ? p.range : []), "--", p.path];
}
