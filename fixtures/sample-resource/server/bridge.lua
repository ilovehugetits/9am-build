-- Distilled from 9am-vehicleshop/server/bridge.lua: load-time framework
-- detection plus normalized player access — the 9AM house pattern the
-- framework batteries exist to serve. Returned as a module so specs can
-- TestHelpers.reload() it after switching the active framework.

local Bridge = {}

local isQBox   = GetResourceState('qbx_core') == 'started'
local isQBCore = GetResourceState('qb-core') == 'started'
local isESX    = GetResourceState('es_extended') == 'started'

if not isQBox and not isQBCore and not isESX then
  error('no supported framework found (qbx_core, qb-core, or es_extended)')
end

Bridge.framework = isQBox and 'QBox' or (isQBCore and 'QBCore' or 'ESX')

local QBCoreObj
if isQBCore then
  QBCoreObj = exports['qb-core']:GetCoreObject()
end

local ESXObj
if isESX then
  ESXObj = exports['es_extended']:getSharedObject()
end

--- Wrap an ESX xPlayer into the QB-compatible shape all consumers use.
local function wrapESXPlayer(xPlayer)
  if not xPlayer then return nil end
  return {
    PlayerData = {
      source = xPlayer.source,
      citizenid = xPlayer.identifier,
      job = { name = xPlayer.job.name, grade = { level = xPlayer.job.grade } },
    },
    Functions = {
      GetMoney = function(account)
        if account == 'cash' or account == 'money' then
          return xPlayer.getMoney()
        end
        local acc = xPlayer.getAccount(account)
        return acc and acc.money or 0
      end,
      RemoveMoney = function(account, amount)
        local balance
        if account == 'cash' or account == 'money' then
          balance = xPlayer.getMoney()
        else
          local acc = xPlayer.getAccount(account)
          balance = acc and acc.money or 0
        end
        if balance < amount then return false end
        if account == 'cash' or account == 'money' then
          xPlayer.removeMoney(amount)
        else
          xPlayer.removeAccountMoney(account, amount)
        end
        return true
      end,
    },
  }
end

function Bridge.GetPlayer(src)
  if isESX then
    return wrapESXPlayer(ESXObj.GetPlayerFromId(src))
  elseif isQBox then
    return exports.qbx_core:GetPlayer(src)
  else
    return QBCoreObj.Functions.GetPlayer(src)
  end
end

--- Charge a player; returns false when they cannot afford it.
function Bridge.Charge(src, account, amount)
  local player = Bridge.GetPlayer(src)
  if not player then return false end
  return player.Functions.RemoveMoney(account, amount)
end

return Bridge
