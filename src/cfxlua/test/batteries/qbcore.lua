-- QBCore battery: the core object reachable through
-- exports['qb-core']:GetCoreObject() and as the QBCore global, backed by the
-- shared player state.

return function(state)
  local QBCore = {
    Functions = {},
    Commands = { List = {} },
    Shared = {
      Jobs = {},        -- materialized from the shared jobs registry below
      Gangs = state.gangs,
      Items = {},
      Vehicles = {},
    },
  }

  -- ------------------------------------------------------------
  -- Shared.Jobs stays a plain table (resources index and even assign into
  -- it), rebuilt in place whenever the registry changes. qb-core keys grades
  -- by string.
  -- ------------------------------------------------------------

  state.onJobsChanged(function()
    local jobs = QBCore.Shared.Jobs
    for name in pairs(jobs) do jobs[name] = nil end
    for name, job in pairs(state.jobs) do
      local grades = {}
      for level, grade in pairs(job.grades) do
        grades[tostring(level)] = {
          name = grade.name,
          payment = grade.payment,
          isboss = grade.isboss,
        }
      end
      jobs[name] = { label = job.label, defaultDuty = job.defaultDuty, grades = grades }
    end
  end)

  -- ------------------------------------------------------------
  -- Shared utils
  -- ------------------------------------------------------------

  function QBCore.Shared.RandomStr(length)
    local out = {}
    for i = 1, length do
      out[i] = string.char(math.random(97, 122))
    end
    return table.concat(out)
  end

  function QBCore.Shared.RandomInt(length)
    local out = {}
    for i = 1, length do
      out[i] = tostring(math.random(0, 9))
    end
    return table.concat(out)
  end

  function QBCore.Shared.Round(value, decimals)
    local factor = 10 ^ (decimals or 0)
    return math.floor(value * factor + 0.5) / factor
  end

  function QBCore.Shared.Trim(value)
    return value and value:match('^%s*(.-)%s*$') or nil
  end

  -- ------------------------------------------------------------
  -- Functions
  -- ------------------------------------------------------------

  function QBCore.Functions.GetPlayer(source)
    return state.getQBPlayer(source)
  end

  function QBCore.Functions.GetPlayerByCitizenId(citizenid)
    local record = state.findByCitizenId(citizenid)
    return record and state.getQBPlayer(record.source) or nil
  end

  function QBCore.Functions.GetQBPlayers()
    return state.getQBPlayers()
  end

  function QBCore.Functions.GetPlayers()
    local sources = {}
    for source in pairs(state.players) do
      sources[#sources + 1] = source
    end
    return sources
  end

  function QBCore.Functions.CreateCallback(name, fn)
    state.registerCallback(name, 'cb', fn)
  end

  function QBCore.Functions.TriggerCallback(name, source, cb, ...)
    local results = table.pack(state.triggerCallback(name, source, ...))
    if cb then cb(table.unpack(results, 1, results.n)) end
  end

  function QBCore.Functions.CreateUseableItem(name, fn)
    state.registerUseable(name, 'qb', fn)
  end

  function QBCore.Functions.UseItem(source, item)
    return state.useItem(source, type(item) == 'table' and item.name or item)
  end

  function QBCore.Functions.HasItem(source, items, amount)
    local record = state.getRecord(source)
    if not record then return false end
    local wanted = type(items) == 'table' and items or { items }
    for _, name in pairs(wanted) do
      local item = state.findItem(record, name)
      if not item or item.amount < (amount or 1) then return false end
    end
    return true
  end

  function QBCore.Functions.Notify(source, text, notifyType, duration)
    state.notify(source, { text = text, type = notifyType, duration = duration })
  end

  --- Client shape: current player's data, from the default source.
  function QBCore.Functions.GetPlayerData(cb)
    local player = state.getQBPlayer(state.defaultSource())
    local data = player and player.PlayerData or {}
    if cb then cb(data) end
    return data
  end

  -- ------------------------------------------------------------
  -- Commands
  -- ------------------------------------------------------------

  function QBCore.Commands.Add(name, help, arguments, argsrequired, callback, permission)
    QBCore.Commands.List[name] = {
      help = help,
      arguments = arguments,
      argsrequired = argsrequired,
      permission = permission,
    }
    RegisterCommand(name, function(source, args, raw)
      callback(source, args, raw)
    end, permission ~= nil and permission ~= 'user')
  end

  function QBCore.Commands.Refresh() end

  -- ------------------------------------------------------------
  -- qb-core exports (the surface bridge files consume)
  -- ------------------------------------------------------------

  local function upsertJob(name, job)
    state.setJob(name, job)
    TriggerEvent('QBCore:Server:UpdateObject')
    return true
  end

  state.registerExports('qb-core', {
    GetCoreObject = function(_)
      return QBCore
    end,
    AddJob = function(_, name, job)
      return upsertJob(name, job)
    end,
    UpdateJob = function(_, name, job)
      return upsertJob(name, job)
    end,
    AddItem = function(_, name, item)
      QBCore.Shared.Items[name] = item
      return true
    end,
    AddItems = function(_, items)
      for name, item in pairs(items) do
        QBCore.Shared.Items[name] = item
      end
      return true
    end,
  })

  _G.QBCore = QBCore
  state.loaded.qbcore = true
  return QBCore
end
