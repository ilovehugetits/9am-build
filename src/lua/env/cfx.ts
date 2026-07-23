/**
 * CitizenFX native stubs.
 *
 * Exported as Lua source rather than a JS object: these fakes need real Lua
 * semantics (varargs, multiple returns, metatables), which is far clearer
 * expressed in Lua than reconstructed across the bridge.
 */
export const CFX_ENV_LUA = `
local H = rawget(_G, "__harness")

-- Events ----------------------------------------------------------------

function RegisterNetEvent(name, handler)
    H.events[name] = H.events[name] or {}
    if handler then table.insert(H.events[name], handler) end
end

function AddEventHandler(name, handler)
    H.events[name] = H.events[name] or {}
    table.insert(H.events[name], handler)
    return { name = name }
end

RegisterServerEvent = RegisterNetEvent
RemoveEventHandler = function() end

function TriggerEvent(name, ...)
    local handlers = H.events[name]
    if not handlers then return end
    for _, fn in ipairs(handlers) do fn(...) end
end

function TriggerClientEvent(name, target, ...)
    H.calls[#H.calls + 1] = { kind = 'clientEvent', name = name, target = target, args = { ... } }
end

function TriggerServerEvent(name, ...)
    H.calls[#H.calls + 1] = { kind = 'serverEvent', name = name, args = { ... } }
end

TriggerLatentClientEvent = TriggerClientEvent

-- Threads ---------------------------------------------------------------
-- Recorded, never executed. Resource code routinely wraps an infinite
-- \`while true do ... end\` loop in CreateThread at file scope; running it
-- synchronously would hang the runner forever.

function CreateThread(fn)
    H.threads[#H.threads + 1] = fn
end

function SetTimeout(_, fn)
    H.threads[#H.threads + 1] = fn
end

function Wait(_) end

Citizen = {
    CreateThread = CreateThread,
    Wait = Wait,
    SetTimeout = SetTimeout,
    CreateThreadNow = CreateThread,
    InvokeNative = function() return nil end,
}

-- Vector value types -----------------------------------------------------
-- CfxLua exposes vector2/3/4 and quat as built-in globals. Config files are
-- full of them at file scope, so a resource cannot even load without these.

local function makeVector(fields)
    local mt = {}
    mt.__index = mt
    mt.__eq = function(a, b)
        for _, f in ipairs(fields) do
            if a[f] ~= b[f] then return false end
        end
        return true
    end
    mt.__tostring = function(v)
        local parts = {}
        for _, f in ipairs(fields) do parts[#parts + 1] = tostring(v[f]) end
        return 'vector' .. #fields .. '(' .. table.concat(parts, ', ') .. ')'
    end
    mt.__add = function(a, b)
        local out = {}
        for _, f in ipairs(fields) do out[f] = (a[f] or 0) + (b[f] or 0) end
        return setmetatable(out, mt)
    end
    mt.__sub = function(a, b)
        local out = {}
        for _, f in ipairs(fields) do out[f] = (a[f] or 0) - (b[f] or 0) end
        return setmetatable(out, mt)
    end
    return function(...)
        local args = { ... }
        local out = {}
        for i, f in ipairs(fields) do out[f] = args[i] or 0 end
        return setmetatable(out, mt)
    end
end

vector2 = makeVector({ 'x', 'y' })
vector3 = makeVector({ 'x', 'y', 'z' })
vector4 = makeVector({ 'x', 'y', 'z', 'w' })
quat = makeVector({ 'x', 'y', 'z', 'w' })
vec2, vec3, vec4 = vector2, vector3, vector4
vec = vector3

-- Permissions and players ------------------------------------------------

function IsPlayerAceAllowed() return false end
function GetPlayerName() return 'TestPlayer' end
function GetPlayers() return {} end
function GetPlayerPed() return 0 end
function GetPlayerIdentifier() return 'license:test' end
function GetPlayerIdentifiers() return { 'license:test' } end
function GetNumPlayerIdentifiers() return 1 end
function DropPlayer() end
function ExecuteCommand() end
function RegisterCommand() end

-- Resource metadata ------------------------------------------------------

function GetCurrentResourceName() return H.resourceName end
function GetResourceState() return 'started' end
function GetGameTimer() return 0 end
function GetHashKey(s) return s end
function GetInvokingResource() return nil end

-- Entities and buckets ---------------------------------------------------

function DoesEntityExist() return false end
function DeleteEntity() end
function SetPlayerRoutingBucket() end
function GetPlayerRoutingBucket() return 0 end
function SetEntityRoutingBucket() end
function NetworkGetEntityFromNetworkId() return 0 end
function NetworkGetNetworkIdFromEntity() return 0 end

-- exports ----------------------------------------------------------------
-- \`exports.foo:bar()\` and \`exports['foo']:bar()\` both resolve to a recorder
-- that returns nil, so a resource dependency that is not installed cannot
-- break a load.

exports = setmetatable({}, {
    __index = function(_, resource)
        return setmetatable({}, {
            __index = function(_, method)
                return function(_, ...)
                    H.calls[#H.calls + 1] = {
                        kind = 'export', resource = resource, method = method, args = { ... },
                    }
                    return nil
                end
            end,
        })
    end,
    __call = function(_, name, fn)
        H.calls[#H.calls + 1] = { kind = 'exportRegister', name = name }
        return fn
    end,
})
`;
