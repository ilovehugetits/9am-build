-- QBox battery: the qbx_core exports surface. Player objects reuse the shared
-- QB shape — qbx_core deliberately keeps qb-core's player object layout.

return function(state)
  local function getPlayer(source)
    return state.getQBPlayer(source)
  end

  state.registerExports('qbx_core', {
    GetPlayer = function(_, source)
      return getPlayer(source)
    end,
    GetPlayerByCitizenId = function(_, citizenid)
      local record = state.findByCitizenId(citizenid)
      return record and getPlayer(record.source) or nil
    end,
    GetQBPlayers = function(_)
      return state.getQBPlayers()
    end,
    SetJob = function(_, source, job, grade)
      local player = getPlayer(source)
      if not player then return false end
      return player.Functions.SetJob(job, grade)
    end,
    GetJobs = function(_)
      -- qbx_core keys grades by number
      local jobs = {}
      for name, job in pairs(state.jobs) do
        local grades = {}
        for level, grade in pairs(job.grades) do
          grades[level] = { name = grade.name, payment = grade.payment, isboss = grade.isboss }
        end
        jobs[name] = { label = job.label, defaultDuty = job.defaultDuty, grades = grades }
      end
      return jobs
    end,
    CreateJob = function(_, name, job, _commitToFile)
      state.setJob(name, job)
      return true
    end,
    GetDutyCountJob = function(_, jobName)
      local count = 0
      for _, record in pairs(state.players) do
        if record.job.name == jobName and record.job.onduty then
          count = count + 1
        end
      end
      return count
    end,
    GetMoney = function(_, source, account)
      local record = state.getRecord(source)
      return record and state.getMoney(record, account) or nil
    end,
    AddMoney = function(_, source, account, amount, _reason)
      local record = state.getRecord(source)
      if not record then return false end
      state.addMoney(record, account, amount)
      return true
    end,
    RemoveMoney = function(_, source, account, amount, _reason)
      local record = state.getRecord(source)
      if not record then return false end
      return state.removeMoney(record, account, amount)
    end,
    Notify = function(_, source, text, notifyType, duration)
      state.notify(source, { text = text, type = notifyType, duration = duration })
    end,
  })

  -- qbx_core registers this ox_lib callback for its client playerdata module;
  -- resource client files fetch it via lib.callback.await.
  if rawget(_G, 'lib') then
    lib.callback.register('QBCore:GetCurrentPlayer', function(source)
      local player = getPlayer(source)
      return player and player.PlayerData or nil
    end)
  end

  state.loaded.qbox = true
end
