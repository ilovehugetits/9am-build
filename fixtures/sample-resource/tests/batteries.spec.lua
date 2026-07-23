-- Coverage for the framework batteries (ox_lib / QBCore / QBox / ESX fakes).
-- Exercises the same bridge pattern real 9AM resources use, plus the
-- cross-framework state sharing the batteries promise.

local function seedPlayer(source, opts)
  TestHelpers.framework.addPlayer(source, opts)
end

describe('framework detection (server/bridge.lua pattern)', function()
  beforeEach(function()
    TestHelpers.framework.reset()
  end)

  afterEach(function()
    TestHelpers.framework.use('qbox')
  end)

  local cases = {
    { use = 'qbox', expected = 'QBox' },
    { use = 'qbcore', expected = 'QBCore' },
    { use = 'esx', expected = 'ESX' },
  }

  for _, case in ipairs(cases) do
    it('detects ' .. case.expected .. ' and charges through its player object', function()
      TestHelpers.framework.use(case.use)
      local Bridge = TestHelpers.reload('server.bridge')
      expect(Bridge.framework).to.equal(case.expected)

      seedPlayer(1, { money = { bank = 1000 } })
      expect(Bridge.Charge(1, 'bank', 400)).to.be_truthy()
      expect(TestHelpers.framework.getState(1).money.bank).to.equal(600)
      expect(Bridge.Charge(1, 'bank', 10000)).to.be_falsy()
      expect(Bridge.Charge(99, 'bank', 1)).to.be_falsy()
    end)
  end

  it('errors when no framework is active', function()
    TestHelpers.framework.use('none')
    expect(function() TestHelpers.reload('server.bridge') end)
      .to.throw('no supported framework found')
  end)

  it('reports resource states like a real server', function()
    TestHelpers.framework.use('esx')
    expect(GetResourceState('es_extended')).to.equal('started')
    expect(GetResourceState('qb-core')).to.equal('missing')
    expect(GetResourceState('qbx_core')).to.equal('missing')
    expect(GetResourceState('ox_lib')).to.equal('started')
    expect(GetResourceState('oxmysql')).to.equal('started')
  end)
end)

describe('shared player state across framework views', function()
  beforeEach(function()
    TestHelpers.framework.reset()
    TestHelpers.framework.use('qbcore')
  end)

  afterEach(function()
    TestHelpers.framework.use('qbox')
  end)

  it('reflects QB money mutations in the ESX view', function()
    seedPlayer(7, { money = { cash = 250 } })
    local player = QBCore.Functions.GetPlayer(7)
    player.Functions.RemoveMoney('cash', 100)

    local xPlayer = ESX.GetPlayerFromId(7)
    expect(xPlayer.getMoney()).to.equal(150)

    xPlayer.addAccountMoney('bank', 500)
    expect(player.Functions.GetMoney('bank')).to.equal(5500)
  end)

  it('reflects QB item mutations in the ESX view', function()
    seedPlayer(7, {})
    local player = QBCore.Functions.GetPlayer(7)
    player.Functions.AddItem('lockpick', 3)
    expect(ESX.GetPlayerFromId(7).getInventoryItem('lockpick').count).to.equal(3)
    expect(QBCore.Functions.HasItem(7, 'lockpick', 2)).to.be_truthy()
    expect(player.Functions.RemoveItem('lockpick', 5)).to.be_falsy()
    expect(player.Functions.RemoveItem('lockpick', 3)).to.be_truthy()
    expect(player.Functions.GetItemByName('lockpick')).to.be_nil()
  end)

  it('finds players by citizenid through every entry point', function()
    seedPlayer(3, { citizenid = 'ABC123' })
    expect(QBCore.Functions.GetPlayerByCitizenId('ABC123').PlayerData.source).to.equal(3)
    expect(exports.qbx_core:GetPlayerByCitizenId('ABC123').PlayerData.source).to.equal(3)
    expect(ESX.GetPlayerFromIdentifier('ABC123').source).to.equal(3)
  end)
end)

describe('callbacks land in one registry', function()
  beforeEach(function()
    TestHelpers.framework.reset()
  end)

  it('dispatches ox_lib callbacks with an explicit source', function()
    lib.callback.register('batteries:oxEcho', function(source, value)
      return source, value * 2
    end)
    local source, doubled = TestHelpers.callback('batteries:oxEcho', 42, 10)
    expect(source).to.equal(42)
    expect(doubled).to.equal(20)
  end)

  it('lib.callback.await reaches server handlers with the default source', function()
    lib.callback.register('batteries:whoami', function(source)
      return source
    end)
    expect(lib.callback.await('batteries:whoami', false)).to.equal(1)
  end)

  it('dispatches QBCore cb-style callbacks', function()
    QBCore.Functions.CreateCallback('batteries:qbSum', function(source, cb, a, b)
      cb(a + b, source)
    end)
    local sum, source = TestHelpers.callback('batteries:qbSum', 5, 2, 3)
    expect(sum).to.equal(5)
    expect(source).to.equal(5)

    local viaTrigger
    QBCore.Functions.TriggerCallback('batteries:qbSum', 9, function(result)
      viaTrigger = result
    end, 1, 1)
    expect(viaTrigger).to.equal(2)
  end)

  it('dispatches ESX server callbacks', function()
    ESX.RegisterServerCallback('batteries:esxEcho', function(source, cb, value)
      cb(value .. '!', source)
    end)
    local value, source = TestHelpers.callback('batteries:esxEcho', 4, 'hey')
    expect(value).to.equal('hey!')
    expect(source).to.equal(4)

    local viaTrigger
    ESX.TriggerServerCallback('batteries:esxEcho', function(result)
      viaTrigger = result
    end, 'yo')
    expect(viaTrigger).to.equal('yo!')
  end)
end)

describe('notifications from every framework land in one log', function()
  beforeEach(function()
    TestHelpers.framework.reset()
    seedPlayer(2, {})
  end)

  it('records lib.notify, QBCore, QBox and ESX notifications', function()
    lib.notify({ description = 'from ox', type = 'error' })
    QBCore.Functions.Notify(2, 'from qbcore', 'success')
    exports.qbx_core:Notify(2, 'from qbox', 'inform')
    ESX.GetPlayerFromId(2).showNotification('from esx')

    local log = TestHelpers.framework.notifications()
    expect(#log).to.equal(4)
    expect(log[1].args.description).to.equal('from ox')
    expect(log[2].args.text).to.equal('from qbcore')
    expect(log[3].source).to.equal(2)
    expect(log[4].args.text).to.equal('from esx')

    TestHelpers.framework.clearNotifications()
    expect(#TestHelpers.framework.notifications()).to.equal(0)
  end)
end)

describe('jobs registry is shared by all frameworks', function()
  beforeEach(function()
    TestHelpers.framework.reset()
  end)

  it('a job added via qb-core exports is visible everywhere', function()
    expect(exports['qb-core']:AddJob('cardealer', {
      label = 'Vehicle Dealer',
      grades = {
        ['0'] = { name = 'Recruit', payment = 50 },
        ['1'] = { name = 'Manager', payment = 100, isboss = true },
      },
    })).to.be_truthy()

    expect(QBCore.Shared.Jobs.cardealer.label).to.equal('Vehicle Dealer')
    expect(QBCore.Shared.Jobs.cardealer.grades['1'].isboss).to.be_truthy()
    expect(exports.qbx_core:GetJobs().cardealer.grades[1].isboss).to.be_truthy()
    expect(ESX.GetJobs().cardealer.grades['1'].name).to.equal('boss')
  end)

  it('SetJob updates the player through every view', function()
    exports.qbx_core:CreateJob('mechanic', {
      label = 'Mechanic',
      grades = { [0] = { name = 'Apprentice', payment = 25 } },
    })
    seedPlayer(4, {})

    expect(exports.qbx_core:SetJob(4, 'mechanic', 0)).to.be_truthy()
    local player = QBCore.Functions.GetPlayer(4)
    expect(player.PlayerData.job.name).to.equal('mechanic')
    expect(player.PlayerData.job.grade.level).to.equal(0)
    expect(ESX.GetPlayerFromId(4).getJob().name).to.equal('mechanic')
    expect(player.Functions.SetJob('ghost-job', 0)).to.be_falsy()

    expect(exports.qbx_core:GetDutyCountJob('mechanic')).to.equal(1)
    expect(exports.qbx_core:GetDutyCountJob('police')).to.equal(0)
  end)
end)

describe('useable items', function()
  beforeEach(function()
    TestHelpers.framework.reset()
    seedPlayer(5, { items = { { name = 'bandage', amount = 2 } } })
  end)

  it('triggers QB-registered handlers with the item table', function()
    local used
    QBCore.Functions.CreateUseableItem('bandage', function(source, item)
      used = { source = source, name = item.name, amount = item.amount }
    end)
    TestHelpers.framework.useItem(5, 'bandage')
    expect(used).to.deep_equal({ source = 5, name = 'bandage', amount = 2 })
  end)

  it('triggers ESX-registered handlers with the item name', function()
    local used
    ESX.RegisterUsableItem('water', function(source, name)
      used = { source = source, name = name }
    end)
    ESX.UseItem(5, 'water')
    expect(used).to.deep_equal({ source = 5, name = 'water' })
  end)
end)

describe('ox_lib utility surface', function()
  it('exposes the commonly consumed helpers', function()
    expect(lib.table.contains({ 'a', 'b' }, 'b')).to.be_truthy()
    expect(lib.table.matches({ x = { y = 1 } }, { x = { y = 1 } })).to.be_truthy()
    local clone = lib.table.deepclone({ nested = { value = 7 } })
    expect(clone.nested.value).to.equal(7)
    expect(lib.math.round(2.46, 1)).to.equal(2.5)
    expect(#lib.string.random('AAA111')).to.equal(6)
    expect(locale('game.some.key')).to.equal('game.some.key')
  end)
end)
