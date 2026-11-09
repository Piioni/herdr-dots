-- Inline diff in your own Neovim config (gitsigns): soft line bands, deleted lines inline, no editing noise.
local dir = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h")
-- Opened by ion-changes with ION_DIFF_PARAMS (argv.js): the diff is the working tree against range[1] (HEAD by default).
local ok, params = pcall(vim.json.decode, vim.env.ION_DIFF_PARAMS or "")
local base = ok and type(params) == "table" and params.range and params.range[1] or "HEAD"
vim.api.nvim_create_autocmd("LspAttach", { callback = function(a) pcall(vim.lsp.inlay_hint.enable, false, { bufnr = a.buf }) end })
vim.keymap.set("n", "q", "<cmd>qa!<cr>", { silent = true })
vim.defer_fn(function()
  local g = require("gitsigns")
  -- Diagnostics stay on for the statusline count, but draw nothing in the buffer.
  vim.diagnostic.config({ virtual_text = false, virtual_lines = false, signs = false, underline = false })
  pcall(vim.lsp.inlay_hint.enable, false)
  vim.wo.relativenumber = false
  vim.wo.number = true
  vim.wo.wrap = false
  vim.bo.modifiable = false
  -- The editor is already One Dark; the diff bands go on top of gitsigns' own.
  dofile(dir .. "/onedark.lua").diff()
  -- The shared statusline (statusline.lua), the same as in your editor and in the side-by-side diff.
  local sl = dofile(dir .. "/statusline.lua")
  require("lualine").setup({ options = sl.options, sections = sl.bar(), inactive_sections = sl.bar() })
  g.change_base(base, false, function()
    -- Start on the first change (LazyVim would restore the last cursor position).
    local first = (g.get_hunks() or {})[1]
    if first then vim.api.nvim_win_set_cursor(0, { math.max(first.added.start, 1), 0 }); vim.cmd("normal! zz") end
  end)
  vim.keymap.set("n", "S", function() dofile(dir .. "/swap.lua").swap("side") end, { silent = true, buffer = true })
  g.toggle_linehl(true)
  g.toggle_deleted(true)
  -- Word diff is noisy on rewritten hunks: off by default, `<leader>gW` toggles it.
  vim.keymap.set("n", "<leader>gW", g.toggle_word_diff, { silent = true, buffer = true })
end, 1500)
