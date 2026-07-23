-- Shared player-state core for the framework batteries.
--
-- One canonical record per player; the QBCore/QBox/ESX batteries are thin
-- adapter views over this table, so money removed through one framework's API
-- is visible through every other framework's API. The adapters also share the
-- callback / useable-item / job registries defined here, which is what lets
-- TestHelpers.callback() dispatch a handler regardless of which framework
-- registered it.

local S = {
  players = {},          -- source -> canonical record
  qbPlayers = {},        -- source -> cached QB-shape player object
  esxPlayers = {},       -- source -> cached xPlayer object
  jobs = {},             -- name -> { label, defaultDuty, grades = { [0] = { name, payment, isboss } } }
  gangs = {},            -- name -> { label, grades = ... }
  notifications = {},    -- { { source, args }, ... }
  callbacks = {},        -- name -> { style = 'ox' | 'cb', fn }
  useables = {},         -- name -> { style = 'qb' | 'esx', fn }
  jobListeners = {},     -- fns run after every jobs-registry mutation
  activeFramework = 'qbox',
  loaded = {},           -- battery name -> true
  defaultSourceId = 1,
}

S.jobs.unemployed = {
  label = 'Civilian',
  defaultDuty = true,
  grades = { [0] = { name = 'Freelancer', payment = 10 } },
}
S.gangs.none = {
  label = 'No Gang',
  grades = { [0] = { name = 'Unaffiliated' } },
}

local FRAMEWORK_RESOURCES = {
  qbox = 'qbx_core',
  qbcore = 'qb-core',
  esx = 'es_extended',
}

function S.defaultSource(src)
  if src ~= nil then S.defaultSourceId = src end
  return S.defaultSourceId
end

-- ============================================================
-- exports registration
-- ============================================================

--- Register functions under another resource's export table.
--- The runtime's exports proxy only exposes a writable handle while the
--- resource is still unregistered, so the proxy is captured once and every
--- function is assigned through it.
function S.registerExports(resourceName, fns)
  local proxy = exports[resourceName]
  for name, fn in pairs(fns) do
    proxy[name] = fn
  end
end

-- ============================================================
-- GetResourceState overlay
-- ============================================================

--- Reports exactly one framework resource as started — like a real server —
--- plus ox_lib/oxmysql, whose globals genuinely exist in this runtime.
function S.installResourceStateOverlay()
  local original = GetResourceState
  function GetResourceState(resource)
    for battery, name in pairs(FRAMEWORK_RESOURCES) do
      if resource == name then
        return (S.loaded[battery] and S.activeFramework == battery) and 'started' or 'missing'
      end
    end
    if resource == 'ox_lib' then
      return S.loaded.oxlib and 'started' or 'missing'
    end
    if resource == 'oxmysql' then
      return 'started'
    end
    return original(resource)
  end
end

function S.use(name)
  if name ~= 'none' and not FRAMEWORK_RESOURCES[name] then
    error(("unknown framework '%s' (expected qbox, qbcore, esx or none)"):format(tostring(name)), 2)
  end
  if name ~= 'none' and not S.loaded[name] then
    error(("framework '%s' is disabled by the batteries selection"):format(name), 2)
  end
  S.activeFramework = name
end

-- ============================================================
-- Notifications
-- ============================================================

function S.notify(source, args)
  S.notifications[#S.notifications + 1] = { source = source, args = args }
end

-- ============================================================
-- Jobs registry (canonical: grades keyed by numeric level from 0)
-- ============================================================

local function notifyJobListeners()
  for _, fn in ipairs(S.jobListeners) do fn() end
end

function S.onJobsChanged(fn)
  S.jobListeners[#S.jobListeners + 1] = fn
  fn()
end

--- Accepts grades keyed by number (QBox) or by string (qb-core / ESX).
function S.setJob(name, job)
  local grades = {}
  for key, grade in pairs(job.grades or {}) do
    local level = tonumber(key)
    if level then
      grades[level] = {
        name = grade.name or grade.label or tostring(level),
        payment = grade.payment or grade.salary or 0,
        isboss = grade.isboss or nil,
      }
    end
  end
  S.jobs[name] = {
    label = job.label or name,
    defaultDuty = job.defaultDuty ~= false,
    grades = grades,
  }
  notifyJobListeners()
end

-- ============================================================
-- Player records
-- ============================================================

local function normalizeAccount(account)
  if account == 'money' then return 'cash' end
  return account
end

function S.addPlayer(source, opts)
  opts = opts or {}
  local jobOpts = opts.job or {}
  local jobName = jobOpts.name or 'unemployed'
  local jobDef = S.jobs[jobName]
  local gradeLevel = jobOpts.grade or 0
  local gradeDef = jobDef and jobDef.grades[gradeLevel] or nil

  local record = {
    source = source,
    citizenid = opts.citizenid or ('CID' .. tostring(source)),
    license = opts.license or ('license:' .. tostring(source)),
    firstname = opts.firstname or 'Test',
    lastname = opts.lastname or ('Player' .. tostring(source)),
    job = {
      name = jobName,
      label = jobOpts.label or (jobDef and jobDef.label) or jobName,
      grade = gradeLevel,
      gradeName = jobOpts.gradeName or (gradeDef and gradeDef.name) or tostring(gradeLevel),
      isboss = jobOpts.isboss or (gradeDef and gradeDef.isboss) or false,
      onduty = jobOpts.onduty ~= false,
    },
    money = { cash = 500, bank = 5000, crypto = 0 },
    items = {},
    metadata = opts.metadata or {},
  }
  for account, amount in pairs(opts.money or {}) do
    record.money[normalizeAccount(account)] = amount
  end
  for _, item in ipairs(opts.items or {}) do
    record.items[#record.items + 1] = {
      name = item.name,
      label = item.label or item.name,
      amount = item.amount or item.count or 1,
      info = item.info or {},
      slot = item.slot or #record.items + 1,
    }
  end

  S.players[source] = record
  S.qbPlayers[source] = nil
  S.esxPlayers[source] = nil
  if rawget(_G, '__cfx_addMockPlayer') then
    __cfx_addMockPlayer(source, record.firstname .. ' ' .. record.lastname, record.license)
  end
  return record
end

function S.removePlayer(source)
  S.players[source] = nil
  S.qbPlayers[source] = nil
  S.esxPlayers[source] = nil
  if rawget(_G, '__cfx_removeMockPlayer') then
    __cfx_removeMockPlayer(source)
  end
end

function S.getRecord(source)
  return S.players[source]
end

function S.findByCitizenId(citizenid)
  for _, record in pairs(S.players) do
    if record.citizenid == citizenid then return record end
  end
  return nil
end

function S.reset()
  S.players = {}
  S.qbPlayers = {}
  S.esxPlayers = {}
  S.notifications = {}
end

-- ============================================================
-- Money / items (shared mutation helpers)
-- ============================================================

function S.getMoney(record, account)
  return record.money[normalizeAccount(account)] or 0
end

function S.addMoney(record, account, amount)
  account = normalizeAccount(account)
  record.money[account] = (record.money[account] or 0) + amount
end

function S.removeMoney(record, account, amount)
  account = normalizeAccount(account)
  local balance = record.money[account] or 0
  if balance < amount then return false end
  record.money[account] = balance - amount
  return true
end

function S.setMoney(record, account, amount)
  record.money[normalizeAccount(account)] = amount
end

function S.findItem(record, name)
  for index, item in ipairs(record.items) do
    if item.name == name then return item, index end
  end
  return nil
end

function S.addItem(record, name, amount, info, slot)
  amount = amount or 1
  local item = S.findItem(record, name)
  if item then
    item.amount = item.amount + amount
  else
    record.items[#record.items + 1] = {
      name = name,
      label = name,
      amount = amount,
      info = info or {},
      slot = slot or #record.items + 1,
    }
  end
  return true
end

function S.removeItem(record, name, amount)
  amount = amount or 1
  local item, index = S.findItem(record, name)
  if not item or item.amount < amount then return false end
  item.amount = item.amount - amount
  if item.amount == 0 then table.remove(record.items, index) end
  return true
end

-- ============================================================
-- Callback / useable-item dispatch
-- ============================================================

function S.registerCallback(name, style, fn)
  S.callbacks[name] = { style = style, fn = fn }
end

--- Invokes a registered callback with an explicit source and returns its
--- results, whichever framework registered it. cb-style handlers get a
--- capturing cb; anything they resolve synchronously is returned.
function S.triggerCallback(name, source, ...)
  local entry = S.callbacks[name]
  if not entry then
    error(("no callback registered under '%s'"):format(name), 2)
  end
  if entry.style == 'ox' then
    return entry.fn(source, ...)
  end
  local captured
  entry.fn(source, function(...) captured = table.pack(...) end, ...)
  if captured then
    return table.unpack(captured, 1, captured.n)
  end
end

function S.registerUseable(name, style, fn)
  S.useables[name] = { style = style, fn = fn }
end

function S.useItem(source, name)
  local entry = S.useables[name]
  if not entry then
    error(("no useable item registered under '%s'"):format(name), 2)
  end
  if entry.style == 'esx' then
    return entry.fn(source, name)
  end
  local record = S.players[source]
  local item = record and S.findItem(record, name) or nil
  return entry.fn(source, item or { name = name, amount = 0 })
end

-- ============================================================
-- QB-shape player objects (shared by the QBCore and QBox batteries —
-- QBox deliberately keeps qb-core's player shape)
-- ============================================================

local function syncQBJob(pd, job)
  pd.job.name = job.name
  pd.job.label = job.label
  pd.job.isboss = job.isboss
  pd.job.onduty = job.onduty
  pd.job.grade.level = job.grade
  pd.job.grade.name = job.gradeName
end

function S.getQBPlayer(source)
  local record = S.players[source]
  if not record then return nil end

  local cached = S.qbPlayers[source]
  if cached then return cached end

  local pd = {
    source = source,
    citizenid = record.citizenid,
    license = record.license,
    charinfo = { firstname = record.firstname, lastname = record.lastname },
    money = record.money,       -- shared reference: mutations reflect instantly
    items = record.items,
    metadata = record.metadata,
    job = { grade = {} },
    gang = { name = 'none', label = 'No Gang', isboss = false, grade = { name = 'none', level = 0 } },
  }
  syncQBJob(pd, record.job)

  local player = { PlayerData = pd }
  player.Functions = {
    GetMoney = function(account)
      return S.getMoney(record, account)
    end,
    AddMoney = function(account, amount, _reason)
      S.addMoney(record, account, amount)
      return true
    end,
    RemoveMoney = function(account, amount, _reason)
      return S.removeMoney(record, account, amount)
    end,
    SetMoney = function(account, amount, _reason)
      S.setMoney(record, account, amount)
      return true
    end,
    AddItem = function(name, amount, slot, info)
      return S.addItem(record, name, amount, info, slot)
    end,
    RemoveItem = function(name, amount, _slot)
      return S.removeItem(record, name, amount)
    end,
    GetItemByName = function(name)
      return S.findItem(record, name)
    end,
    GetItemsByName = function(name)
      local matches = {}
      for _, item in ipairs(record.items) do
        if item.name == name then matches[#matches + 1] = item end
      end
      return matches
    end,
    SetJob = function(name, grade)
      local jobDef = S.jobs[name]
      if not jobDef then return false end
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
      syncQBJob(pd, record.job)
      return true
    end,
    SetMetaData = function(key, value)
      record.metadata[key] = value
    end,
    GetMetaData = function(key)
      return record.metadata[key]
    end,
    Save = function() end,
  }

  S.qbPlayers[source] = player
  return player
end

function S.getQBPlayers()
  local players = {}
  for source in pairs(S.players) do
    players[source] = S.getQBPlayer(source)
  end
  return players
end

return S
