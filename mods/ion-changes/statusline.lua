-- One statusline for every Neovim used with Herdr: your editor and the inline diff (LazyVim loaded),
-- and the side-by-side diff (`standalone`: no LazyVim, no gitsigns; lualine comes from the lazy folder).
local M = {}
local icons = {
  diagnostics = { Error = " ", Warn = " ", Hint = " ", Info = " " },
  git = { added = " ", modified = " ", removed = " " },
}
local lazy = vim.fn.stdpath("data") .. "/lazy"

-- Standalone: added / changed / removed lines and the hunks, from the two diff windows (HEAD side, working tree side).
local cache = {}
local function sides()
  local wins = vim.tbl_filter(function(w) return vim.wo[w].diff end, vim.api.nvim_tabpage_list_wins(0))
  return #wins >= 2 and wins or nil
end
local function hunks()
  local wins = sides()
  if not wins then return nil end
  local a, b = vim.api.nvim_win_get_buf(wins[1]), vim.api.nvim_win_get_buf(wins[2])
  local tick = vim.b[a].changedtick .. ":" .. vim.b[b].changedtick .. ":" .. a .. ":" .. b
  if cache.tick ~= tick then
    local text = function(buf) return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n") .. "\n" end
    cache = { tick = tick, list = vim.diff(text(a), text(b), { result_type = "indices", algorithm = "histogram" }) }
  end
  return cache.list, wins
end
local function stats()
  local list = hunks()
  if not list then return nil end
  local s = { added = 0, modified = 0, removed = 0 }
  for _, h in ipairs(list) do
    local old, new = h[2], h[4]
    if old == 0 then s.added = s.added + new
    elseif new == 0 then s.removed = s.removed + old
    else
      s.modified = s.modified + math.min(old, new)
      if new > old then s.added = s.added + new - old else s.removed = s.removed + old - new end
    end
  end
  return s
end

local function hunk_pos(standalone)
  return function()
    local at, total, line = 0, 0, vim.fn.line(".")
    if standalone then
      local list, wins = hunks()
      if not list then return "" end
      local col = vim.api.nvim_get_current_win() == wins[1] and 1 or 3
      for i, h in ipairs(list) do if h[col] <= line then at = i end end
      total = #list
    else
      local ok, list = pcall(function() return require("gitsigns").get_hunks() end)
      if not ok or not list then return "" end
      for i, h in ipairs(list) do if h.added.start <= line then at = i end end
      total = #list
    end
    return total == 0 and "" or ("hunk %d/%d"):format(math.max(at, 1), total)
  end
end

-- The pwd: the git root of the working directory (LazyVim's own root_dir asks the LSP, which standalone has none of).
local function root_component()
  return {
    function() local r = vim.fs.root(vim.uv.cwd(), ".git"); return vim.fs.basename(r or vim.uv.cwd()) end,
    icon = "󱉭 ",
    color = function() local f = vim.api.nvim_get_hl(0, { name = "Special", link = false }).fg; return f and { fg = ("#%06x"):format(f) } end,
  }
end

--- `o.standalone`: LazyVim is not loaded. `o.hunk` (default true): the "hunk n/N" counter.
--- `o.extras`: progress, line:column and the clock on the right, as in your editor.
function M.bar(o)
  o = o or {}
  local standalone = o.standalone
  local root, path, diff
  if standalone then
    root = root_component()
    path = { function()
      local wins = sides()
      local buf = wins and vim.api.nvim_win_get_buf(wins[2]) or 0
      return vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buf), ":.")
    end }
    -- diff.lua paints DiffDelete dark (filler lines), so the counts get their own colors.
    diff = { "diff", symbols = icons.git, source = stats, diff_color = { added = { fg = "#98c379" }, modified = { fg = "#61afef" }, removed = { fg = "#e06c75" } } }
  else
    root = root_component()
    path = { LazyVim.lualine.pretty_path() }
    icons = LazyVim.config.icons
    diff = { "diff", symbols = icons.git, source = function()
      local d = vim.b.gitsigns_status_dict
      if d then return { added = d.added, modified = d.changed, removed = d.removed } end
    end }
  end
  local x = { diff }
  if o.hunk ~= false then table.insert(x, hunk_pos(standalone)) end
  return {
    lualine_a = { { "mode", separator = { right = vim.fn.nr2char(0xe0b0) } } },
    lualine_b = {},
    lualine_y = o.extras and { { "progress", separator = " ", padding = { left = 1, right = 0 } }, { "location", padding = { left = 0, right = 1 } } } or {},
    lualine_z = o.extras and { { function() return " " .. os.date("%R") end, separator = { left = vim.fn.nr2char(0xe0b2) } } } or {},
    lualine_c = {
      root,
      { "filetype", icon_only = true, separator = "", padding = { left = 1, right = 0 } },
      path,
      { "diagnostics", symbols = { error = icons.diagnostics.Error, warn = icons.diagnostics.Warn, info = icons.diagnostics.Info, hint = icons.diagnostics.Hint } },
    },
    lualine_x = x,
  }
end

M.options = { component_separators = "", section_separators = "" }

-- For a Neovim that skipped your config (VIMINIT): load lualine and the icons from the lazy folder and set the bar up.
function M.standalone()
  for _, p in ipairs({ "lualine.nvim", "mini.icons" }) do vim.opt.rtp:append(lazy .. "/" .. p) end
  local ok_icons, icons_mod = pcall(require, "mini.icons")
  if ok_icons then icons_mod.setup(); icons_mod.mock_nvim_web_devicons() end
  vim.o.laststatus = 3
  local bar = M.bar({ standalone = true })
  require("lualine").setup({ options = vim.tbl_extend("force", M.options, { theme = "auto", globalstatus = true }), sections = bar, inactive_sections = bar })
end

return M
