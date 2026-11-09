-- The swap keys: `u` in the side-by-side diff opens the inline one, `S` in the inline one opens the side-by-side.
-- The other view's command is built from ION_DIFF_PARAMS (argv.js builds the side-by-side one for the first open; keep them in step).
local M = {}
local dir = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h")

local function argv(kind, p)
  local env = { "env", "ION_DIFF_PARAMS=" .. vim.json.encode(p) }
  if kind == "inline" then return vim.list_extend(env, { "nvim", p.path, "-c", "luafile " .. dir .. "/inline.lua" }) end
  vim.list_extend(env, { "VIMINIT=source " .. dir .. "/diff.lua" })
  if p.fresh or (not p.hasHead and p.status == "A") then return vim.list_extend(env, { "nvim", "-R", p.path }) end
  vim.list_extend(env, { "git", "-c", "diff.tool=nvimdiff", "difftool", "-y" })
  if p.hasHead then vim.list_extend(env, p.range) end
  return vim.list_extend(env, { "--", p.path })
end

--- `kind`: "inline" or "side", the view to open. This terminal closes once the other one is open.
function M.swap(kind)
  local ok, p = pcall(vim.json.decode, vim.env.ION_DIFF_PARAMS or "")
  if not ok or type(p) ~= "table" then return end
  if kind == "inline" and (not p.hasHead or p.status == "D" or #p.range ~= 1) then
    return vim.notify("Inline needs the working-tree file against one ref: not available for this diff", vim.log.levels.WARN)
  end
  local name = "diff · " .. vim.fs.basename(p.path)
  local r = vim.system({ "herdr-app", "do", "tab.new", "--name", name, "--folder", p.root, "--argv", vim.json.encode(argv(kind, p)) }):wait()
  if r.code ~= 0 then return vim.notify("Could not open the diff: " .. (r.stderr or ""), vim.log.levels.ERROR) end
  -- A program started with argv runs in your shell, which stays open after it exits: kill the terminal so the tab goes too.
  local me = vim.env.HC_TERMINAL_ID
  local k = me and vim.system({ "herdr-app", "do", "terminal.kill", "--terminal", me }):wait()
  if not k or k.code ~= 0 then vim.cmd("qa!") end
end

return M
