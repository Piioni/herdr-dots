-- One Dark for the diff views. Your editor gets it from the onedark.nvim plugin (~/.config/nvim/lua/plugins/onedark.lua);
-- `load()` does the same for the side-by-side diff, which skips your config; `diff()` sets the diff bands on top.
local M = {}
local c = {
  bg = "#282c34", fg = "#abb2bf", red = "#e06c75", green = "#98c379", yellow = "#e5c07b", blue = "#61afef",
  purple = "#c678dd", cyan = "#56b6c2", orange = "#d19a66", comment = "#7f848e", gutter = "#4b5263",
  line = "#2c313a", sel = "#3e4451", float = "#21252b",
}
M.c = c

--- `fg` over `bg` at opacity `a`: a tint that stays a solid color.
local function blend(fg, bg, a)
  local r = {}
  for _, i in ipairs({ 2, 4, 6 }) do r[#r + 1] = math.floor(tonumber(fg:sub(i, i + 1), 16) * a + tonumber(bg:sub(i, i + 1), 16) * (1 - a) + 0.5) end
  return ("#%02x%02x%02x"):format(r[1], r[2], r[3])
end
M.blend = blend

--- For a Neovim that skipped your config (the side-by-side diff): load the plugin from the lazy folder, as your editor does.
function M.load()
  vim.opt.rtp:append(vim.fn.stdpath("data") .. "/lazy/onedark.nvim")
  require("onedark").setup({ style = "dark", transparent = true, lualine = { transparent = true } })
  require("onedark").load()
end

--- Soft bands (the same tints as the viewer), a stronger one on changed words. Call after the plugins have set theirs.
function M.diff()
  local add, del = blend(c.green, c.bg, 0.19), blend(c.red, c.bg, 0.19)
  local addText, delText = blend(c.green, c.bg, 0.4), blend(c.red, c.bg, 0.4)
  local groups = {
    DiffAdd = { bg = add }, DiffDelete = { fg = del, bg = del }, DiffChange = { bg = blend(c.blue, c.bg, 0.12) },
    DiffText = { bg = blend(c.blue, c.bg, 0.35) }, DiffTextAdd = { bg = addText },
    GitSignsAddLn = { bg = add }, GitSignsChangeLn = { bg = add }, GitSignsAddInline = { bg = addText }, GitSignsChangeInline = { bg = addText },
    GitSignsDeleteVirtLn = { bg = del }, GitSignsChangeVirtLn = { bg = del },
    GitSignsDeleteVirtLnInline = { bg = delText }, GitSignsChangeVirtLnInline = { bg = delText }, GitSignsDeleteInline = { bg = delText },
  }
  for name, spec in pairs(groups) do vim.api.nvim_set_hl(0, name, spec) end
end

return M
