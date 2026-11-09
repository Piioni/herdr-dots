-- Neovim setup used only for Herdr's side-by-side diff tabs (loaded through VIMINIT).
-- One Dark (onedark.lua); the only plugin loaded is lualine (statusline.lua).
local sl_ok, sl = pcall(dofile, vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h") .. "/statusline.lua")

local o = vim.opt
o.termguicolors = true
o.number = true
o.wrap = false
o.mouse = "a"
o.cursorline = true
o.signcolumn = "no"
o.laststatus = 3
o.cmdheight = 0
o.ruler = false
o.showmode = false
o.showcmd = false
o.scrolloff = 6
o.diffopt = { "internal", "filler", "closeoff", "algorithm:histogram", "linematch:60", "context:5", "inline:word" }
o.fillchars = { diff = " ", fold = " ", eob = " ", vert = "│" }
vim.cmd("syntax on")

function _G.diff_foldtext()
  return "   ⋯ " .. (vim.v.foldend - vim.v.foldstart + 1) .. " unchanged lines"
end
o.foldtext = "v:lua.diff_foldtext()"

local od = dofile(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h") .. "/onedark.lua")
od.load()
od.diff()

vim.keymap.set("n", "q", "<cmd>qa!<cr>", { silent = true })
vim.keymap.set("n", "n", "]c", { silent = true })
vim.keymap.set("n", "p", "[c", { silent = true })

-- `u`: the same file inline (your editor with gitsigns), then this Neovim closes.
vim.keymap.set("n", "u", function() dofile(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h") .. "/swap.lua").swap("inline") end, { silent = true })

-- Top labels: the left side is git's temp copy of HEAD, the right one is the file on disk.
vim.api.nvim_create_autocmd("VimEnter", {
  callback = function()
    local wins = vim.api.nvim_tabpage_list_wins(0)
    if #wins == 2 then
      vim.wo[wins[1]].winbar = "  HEAD  %t"
      vim.wo[wins[2]].winbar = "  Working tree  %t%=n/p change · u inline · q quit"
    end
  end,
})

-- The same statusline as the editor and the inline diff (statusline.lua); without it the bar stays off.
if sl_ok then
  local ready, err = pcall(sl.standalone)
  if not ready then vim.o.laststatus = 0; vim.schedule(function() vim.notify("statusline: " .. tostring(err), vim.log.levels.WARN) end) end
else
  vim.o.laststatus = 0
end
