-- ox_lib battery: the `lib` global plus the `locale`/`cache` globals ox_lib
-- injects into every consuming resource.
--
-- Callback semantics under the harness: every handler lives in the shared
-- registry and is always invoked as (source, ...). `lib.callback.await` — the
-- client-side call shape found inside resource client files — dispatches to
-- that registry with TestHelpers.framework's default source, so client-flow
-- code exercises real server handlers without a network in between.

return function(state)
  local lib = {}

  -- ------------------------------------------------------------
  -- callbacks
  -- ------------------------------------------------------------

  local callback = {}

  function callback.register(name, fn)
    state.registerCallback(name, 'ox', fn)
  end

  --- Client shape: lib.callback.await(name, delayOrFalse, ...args)
  function callback.await(name, _delay, ...)
    return state.triggerCallback(name, state.defaultSource(), ...)
  end

  -- Server shape: lib.callback(name, source, cb, ...args)
  setmetatable(callback, {
    __call = function(_, name, source, cb, ...)
      local results = table.pack(state.triggerCallback(name, source, ...))
      if cb then cb(table.unpack(results, 1, results.n)) end
    end,
  })

  lib.callback = callback

  -- ------------------------------------------------------------
  -- notifications / logging
  -- ------------------------------------------------------------

  function lib.notify(data)
    state.notify(state.defaultSource(), data)
  end

  lib.print = {}
  for _, level in ipairs({ 'error', 'warn', 'info', 'verbose', 'debug' }) do
    lib.print[level] = function(...)
      print(('[ox_lib] [%s]'):format(level), ...)
    end
  end

  function lib.logger(_source, _event, _message, ...) end

  function lib.versionCheck() end

  -- ------------------------------------------------------------
  -- locale
  -- ------------------------------------------------------------

  -- Resources that carry their own locale system (the 9AM pattern) load after
  -- the batteries and simply overwrite this fallback.
  local function fallbackLocale(key)
    return key
  end

  function lib.locale()
    if not rawget(_G, 'locale') then
      locale = fallbackLocale
    end
  end

  function lib.getLocale(key)
    return locale and locale(key) or key
  end

  locale = rawget(_G, 'locale') or fallbackLocale

  -- ------------------------------------------------------------
  -- utility modules (the commonly consumed subset)
  -- ------------------------------------------------------------

  lib.table = {}

  function lib.table.deepclone(tbl)
    local copy = {}
    for key, value in pairs(tbl) do
      copy[key] = type(value) == 'table' and lib.table.deepclone(value) or value
    end
    return copy
  end

  function lib.table.matches(a, b)
    if a == b then return true end
    if type(a) ~= 'table' or type(b) ~= 'table' then return false end
    for key, value in pairs(a) do
      if not lib.table.matches(value, b[key]) then return false end
    end
    for key in pairs(b) do
      if a[key] == nil then return false end
    end
    return true
  end

  function lib.table.contains(tbl, value)
    for _, entry in pairs(tbl) do
      if entry == value then return true end
    end
    return false
  end

  lib.string = {}

  local CHAR_SETS = {
    ['1'] = '0123456789',
    ['A'] = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    ['a'] = 'abcdefghijklmnopqrstuvwxyz',
    ['.'] = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  }

  function lib.string.random(pattern, length)
    length = length or #pattern
    local out = {}
    for i = 1, length do
      local kind = pattern:sub(((i - 1) % #pattern) + 1, ((i - 1) % #pattern) + 1)
      local set = CHAR_SETS[kind]
      if set then
        local at = math.random(1, #set)
        out[i] = set:sub(at, at)
      else
        out[i] = kind
      end
    end
    return table.concat(out)
  end

  lib.math = {}

  function lib.math.round(value, places)
    local factor = 10 ^ (places or 0)
    return math.floor(value * factor + 0.5) / factor
  end

  -- ------------------------------------------------------------
  -- commands
  -- ------------------------------------------------------------

  function lib.addCommand(name, _params, cb)
    local names = type(name) == 'table' and name or { name }
    for _, commandName in ipairs(names) do
      RegisterCommand(commandName, function(source, args, raw)
        cb(source, args, raw)
      end, false)
    end
  end

  -- ------------------------------------------------------------
  -- client-side cache table
  -- ------------------------------------------------------------

  cache = {
    resource = GetCurrentResourceName(),
    serverId = state.defaultSource(),
    playerId = 0,
    ped = 0,
    vehicle = false,
    seat = false,
  }

  _G.lib = lib
  state.loaded.oxlib = true
  return lib
end
