# ion-diff

The diff of one file, in its own tab or in a dialog. Opened by [`ion-changes`](../ion-changes); it is not docked anywhere (`"place": "none"`).

## What it does

- One Dark colors (One Dark Pro tokens over the Herdr theme's background, like the transparent Neovim views), line numbers, tinted added/removed rows and syntax colors.
- **Unchanged lines are folded** into "N unchanged lines · click to show" rows. Click one to open it, or turn on *Full file*
  to show the whole file (remembered). Folds of two lines or fewer are just shown.
- **Scales:** the list is virtual with one row height, so only the rows on screen are drawn. Diffs are read up to 20,000 lines;
  past that it says so.
- **Ask about diff:** the button sends the whole file's diff, right-click on a line or a hunk header just that, to an agent
  of the current space as one message, after a question you type (click the agent's name to switch agent).
- **Side-by-side:** the header button opens the same diff in Neovim (props `nvim`) and closes the viewer. 
- Refreshes by itself when the folder changes.

## Props

`tab.new {mod: "ion-diff", props}` or `openOverlay({mod: "ion-diff", kind: "dialog", props})`:

| Prop | Meaning |
|---|---|
| `root`, `on` | The repo folder and its machine (`null`: this one) |
| `path` | The file, relative to `root` |
| `range` | Refs for `git diff`: `["HEAD"]` (working tree vs a ref) or `[parent, commit]` |
| `hasHead`, `fresh`, `status` | Repo has commits; file is untracked; its status letter |
| `label`, `words` | The scope as a word (header) and as a sentence (for the agent) |
| `nvim` | argv of the Neovim diff, for the Side-by-side button (hidden when absent) |
| `font_size` | Overrides the diff's size |

## Files

| File | Role |
|---|---|
| `main.js` | The viewer |
| `diff.js` | Pure row, fill and fold logic (tested) |
| `dialog.js` | The ask dialog |
| `highlight.js` | Tokenizer, from [herdr-reviewer](https://github.com/vytasgavelis/herdr-reviewer) (MIT, see `NOTICE`) |

## Check

```sh
herdr-app check mods/ion-diff
node --test mods/ion-diff/test/*.test.mjs
```
