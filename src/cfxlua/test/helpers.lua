-- FiveM-specific test helpers for the standalone CfxLua runtime.

local M = {}

function M.spy(fn)
  local calls = {}
  local spy

  -- The documented API uses colon calls (spy:call_count()), which inject the
  -- spy as the first argument. Drop it so spy:was_called_with(x) and
  -- spy.was_called_with(x) both compare against the recorded arguments.
  local function expectedArgs(...)
    local n = select("#", ...)
    local args = { ... }
    if n > 0 and args[1] == spy then
      table.remove(args, 1)
      n = n - 1
    end
    args.n = n
    return args
  end

  spy = {
    calls = calls,
    was_called = function()
      return #calls > 0
    end,
    was_called_with = function(...)
      local expected = expectedArgs(...)
      for _, call in ipairs(calls) do
        local match = #call == expected.n
        if match then
          for i = 1, expected.n do
            if call[i] ~= expected[i] then
              match = false
              break
            end
          end
        end
        if match then return true end
      end
      return false
    end,
    call_count = function()
      return #calls
    end,
  }

  setmetatable(spy, {
    __call = function(_, ...)
      calls[#calls + 1] = { ... }
      if fn then return fn(...) end
    end,
  })

  return spy
end

--- Re-require a resource module so its load-time side effects (framework
--- detection, event registration) run again — e.g. after
--- TestHelpers.framework.use() switched the active framework.
function M.reload(name)
  package.loaded[name] = nil
  return require(name)
end

function M.mockGlobal(name, value)
  local previous = _G[name]
  _G[name] = value
  return function()
    _G[name] = previous
  end
end

function M.triggerNetEvent(name, ...)
  if TriggerEvent then
    return TriggerEvent(name, ...)
  end
  error("TriggerEvent is not available in this runtime")
end

function M.assertEventRegistered(name)
  if not AddEventHandler then
    error("AddEventHandler is not available in this runtime")
  end
  local fired = false
  AddEventHandler(name, function()
    fired = true
  end)
  TriggerEvent(name)
  if not fired then
    error("event '" .. name .. "' did not dispatch to handlers")
  end
end

return M
