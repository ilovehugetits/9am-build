-- ESX battery: the shared object reachable through
-- exports['es_extended']:getSharedObject() (and the legacy event), with
-- xPlayer adapters over the shared player state. The ESX 'money' account is
-- the canonical cash balance, so QB-side mutations are visible here and
-- vice versa.

return function(state)
  local ESX = {}

  local ACCOUNT_LABELS = { money = 'Cash', bank = 'Bank', black_money = 'Black Money' }

  -- ------------------------------------------------------------
  -- xPlayer adapters (ESX methods are dot-called closures)
  -- ------------------------------------------------------------

  local function esxAccountName(account)
    if account == 'money' then return 'cash' end
    return account
  end

  local function buildAccounts(record)
    local accounts = {}
    for name, label in pairs(ACCOUNT_LABELS) do
      accounts[#accounts + 1] = {
        name = name,
        money = record.money[esxAccountName(name)] or 0,
        label = label,
      }
    end
    return accounts
  end

  local function syncESXJob(job, source)
    return {
      name = job.name,
      label = job.label,
      grade = job.grade,
      grade_name = job.gradeName,
      grade_label = job.gradeName,
      onDuty = job.onduty,
      source = source,
    }
  end

  local function makeXPlayer(record)
    local xPlayer = {
      source = record.source,
      identifier = record.citizenid,
      name = record.firstname .. ' ' .. record.lastname,
      job = syncESXJob(record.job, record.source),
    }

    local function syncJobView()
      local view = syncESXJob(record.job, record.source)
      for key, value in pairs(view) do xPlayer.job[key] = value end
    end

    xPlayer.getMoney = function()
      return state.getMoney(record, 'cash')
    end
    xPlayer.addMoney = function(amount, _reason)
      state.addMoney(record, 'cash', amount)
    end
    xPlayer.removeMoney = function(amount, _reason)
      state.removeMoney(record, 'cash', amount)
    end
    xPlayer.setMoney = function(amount)
      state.setMoney(record, 'cash', amount)
    end

    xPlayer.getAccount = function(account)
      return {
        name = account,
        money = record.money[esxAccountName(account)] or 0,
        label = ACCOUNT_LABELS[account] or account,
      }
    end
    xPlayer.getAccounts = function()
      return buildAccounts(record)
    end
    xPlayer.addAccountMoney = function(account, amount, _reason)
      state.addMoney(record, esxAccountName(account), amount)
    end
    xPlayer.removeAccountMoney = function(account, amount, _reason)
      state.removeMoney(record, esxAccountName(account), amount)
    end
    xPlayer.setAccountMoney = function(account, amount, _reason)
      state.setMoney(record, esxAccountName(account), amount)
    end

    xPlayer.getInventoryItem = function(name)
      local item = state.findItem(record, name)
      return { name = name, count = item and item.amount or 0, label = item and item.label or name }
    end
    xPlayer.addInventoryItem = function(name, count)
      state.addItem(record, name, count)
    end
    xPlayer.removeInventoryItem = function(name, count)
      state.removeItem(record, name, count)
    end

    xPlayer.setJob = function(name, grade)
      local jobDef = state.jobs[name]
      if not jobDef then return end
      local level = tonumber(grade) or 0
      local gradeDef = jobDef.grades[level] or { name = tostring(level) }
      record.job = {
        name = name,
        label = jobDef.label,
        grade = level,
        gradeName = gradeDef.name,
        isboss = gradeDef.isboss or false,
        onduty = jobDef.defaultDuty,
      }
      syncJobView()
    end
    xPlayer.getJob = function()
      syncJobView()
      return xPlayer.job
    end

    xPlayer.getName = function()
      return xPlayer.name
    end
    xPlayer.setName = function(name)
      xPlayer.name = name
    end
    xPlayer.getIdentifier = function()
      return xPlayer.identifier
    end
    xPlayer.getCoords = function(_asVector)
      return rawget(_G, 'vector3') and vector3(0.0, 0.0, 0.0) or { x = 0.0, y = 0.0, z = 0.0 }
    end
    xPlayer.showNotification = function(message, _type, _length)
      state.notify(record.source, { text = message })
    end
    xPlayer.triggerEvent = function(name, ...)
      TriggerEvent(name, ...)
    end
    xPlayer.kick = function(_reason) end

    return xPlayer
  end

  local function getXPlayer(source)
    local record = state.getRecord(source)
    if not record then return nil end
    local cached = state.esxPlayers[source]
    if cached then return cached end
    local xPlayer = makeXPlayer(record)
    state.esxPlayers[source] = xPlayer
    return xPlayer
  end

  -- ------------------------------------------------------------
  -- shared object
  -- ------------------------------------------------------------

  function ESX.GetPlayerFromId(source)
    return getXPlayer(source)
  end

  function ESX.GetPlayerFromIdentifier(identifier)
    local record = state.findByCitizenId(identifier)
    return record and getXPlayer(record.source) or nil
  end

  function ESX.GetExtendedPlayers(key, value)
    local players = {}
    for source, record in pairs(state.players) do
      local matches = true
      if key == 'job' then matches = record.job.name == value end
      if matches then players[#players + 1] = getXPlayer(source) end
    end
    return players
  end

  function ESX.GetPlayers()
    local sources = {}
    for source in pairs(state.players) do
      sources[#sources + 1] = source
    end
    return sources
  end

  --- ESX keys grades by string; grade `name` is the identifier, `label` the
  --- display name — the reverse of qb-core's fields.
  function ESX.GetJobs()
    local jobs = {}
    for name, job in pairs(state.jobs) do
      local grades = {}
      for level, grade in pairs(job.grades) do
        grades[tostring(level)] = {
          name = grade.isboss and 'boss' or grade.name:lower():gsub('%s+', '_'),
          label = grade.name,
          salary = grade.payment,
        }
      end
      jobs[name] = { label = job.label, grades = grades }
    end
    return jobs
  end

  function ESX.DoesJobExist(name, grade)
    local job = state.jobs[name]
    return job ~= nil and (grade == nil or job.grades[tonumber(grade) or 0] ~= nil)
  end

  function ESX.RefreshJobs() end

  function ESX.RegisterServerCallback(name, fn)
    state.registerCallback(name, 'cb', fn)
  end

  --- Client shape: dispatches to the shared registry with the default source.
  function ESX.TriggerServerCallback(name, cb, ...)
    local results = table.pack(state.triggerCallback(name, state.defaultSource(), ...))
    if cb then cb(table.unpack(results, 1, results.n)) end
  end

  function ESX.RegisterUsableItem(name, fn)
    state.registerUseable(name, 'esx', fn)
  end

  function ESX.UseItem(source, name, ...)
    return state.useItem(source, name)
  end

  function ESX.RegisterCommand(name, _group, cb, _allowConsole, suggestion)
    local names = type(name) == 'table' and name or { name }
    for _, commandName in ipairs(names) do
      RegisterCommand(commandName, function(source, args, _raw)
        cb(getXPlayer(source), args, function(msg) print('[esx] ' .. tostring(msg)) end)
      end, false)
    end
  end

  function ESX.GetItemLabel(name)
    return name
  end

  -- Client-side view: ESX.PlayerData reflects the default source's record.
  setmetatable(ESX, {
    __index = function(_, key)
      if key ~= 'PlayerData' then return nil end
      local record = state.getRecord(state.defaultSource())
      if not record then return {} end
      return {
        source = record.source,
        identifier = record.citizenid,
        name = record.firstname .. ' ' .. record.lastname,
        job = syncESXJob(record.job, record.source),
        accounts = buildAccounts(record),
      }
    end,
  })

  state.registerExports('es_extended', {
    getSharedObject = function(_)
      return ESX
    end,
  })

  AddEventHandler('esx:getSharedObject', function(cb)
    if cb then cb(ESX) end
  end)

  _G.ESX = ESX
  state.loaded.esx = true
  return ESX
end
