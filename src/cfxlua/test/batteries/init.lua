-- Battery loader: reads the selection (NINEAM_TEST_BATTERIES) and initial
-- framework (NINEAM_TEST_FRAMEWORK) forwarded from 9am-test.json, loads the
-- selected battery modules, and attaches the control API to TestHelpers.

local M = {}

local ALL = { 'oxlib', 'qbcore', 'qbox', 'esx' }

local function parseSelection(raw)
  if raw == nil or raw == '' or raw == 'all' or raw == 'true' then
    local selected = {}
    for _, name in ipairs(ALL) do selected[name] = true end
    return selected
  end
  if raw == 'none' or raw == 'false' then return nil end

  local selected = {}
  for name in raw:gmatch('[^,%s]+') do
    selected[name] = true
  end
  return selected
end

--- opts: { dir, selection, framework, helpers }
--- Returns the state module, or nil when batteries are disabled.
function M.load(opts)
  local selected = parseSelection(opts.selection)
  if not selected then return nil end

  local state = dofile(opts.dir .. '/state.lua')

  if selected.oxlib then dofile(opts.dir .. '/oxlib.lua')(state) end
  if selected.qbcore then dofile(opts.dir .. '/qbcore.lua')(state) end
  if selected.qbox then dofile(opts.dir .. '/qbox.lua')(state) end
  if selected.esx then dofile(opts.dir .. '/esx.lua')(state) end

  state.installResourceStateOverlay()

  -- Default to qbox (the 9AM primary stack); when the selection excludes it,
  -- fall back to whichever framework battery is loaded. An explicitly
  -- configured framework that the selection excludes still errors loudly.
  local framework = opts.framework
  if framework == nil or framework == '' then
    framework = 'none'
    for _, candidate in ipairs({ 'qbox', 'qbcore', 'esx' }) do
      if state.loaded[candidate] then
        framework = candidate
        break
      end
    end
  end
  state.use(framework)

  local helpers = opts.helpers

  helpers.framework = {
    use = state.use,
    active = function() return state.activeFramework end,
    defaultSource = state.defaultSource,
    removePlayer = state.removePlayer,
    getState = state.getRecord,
    useItem = state.useItem,
    reset = state.reset,
    addPlayer = function(source, playerOpts)
      state.addPlayer(source, playerOpts)
      if state.activeFramework == 'esx' and rawget(_G, 'ESX') then
        return ESX.GetPlayerFromId(source)
      end
      if state.activeFramework == 'none' then
        return state.getRecord(source)
      end
      return state.getQBPlayer(source) or state.getRecord(source)
    end,
    notifications = function() return state.notifications end,
    clearNotifications = function() state.notifications = {} end,
  }

  helpers.callback = function(name, source, ...)
    return state.triggerCallback(name, source, ...)
  end

  return state
end

return M
