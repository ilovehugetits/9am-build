/**
 * ox_lib stubs. `lib.callback.register` capture is the important one: it is
 * how server-side business logic is reached, so tests invoke handlers through
 * `harness.callback(name, source, ...)`.
 */
export const OXLIB_ENV_LUA = `
local H = rawget(_G, "__harness")

local callback = setmetatable({
    register = function(name, fn)
        H.callbacks[name] = fn
    end,
    await = function(name, ...)
        H.calls[#H.calls + 1] = { kind = 'callbackAwait', name = name, args = { ... } }
        return nil
    end,
}, {
    __call = function(_, name, ...)
        H.calls[#H.calls + 1] = { kind = 'callback', name = name, args = { ... } }
        return nil
    end,
})

lib = {
    callback = callback,
    print = setmetatable({
        info = function() end, warn = function() end,
        error = function() end, debug = function() end,
    }, { __call = function() end }),
    notify = function(...) H.calls[#H.calls + 1] = { kind = 'notify', args = { ... } } end,
    logger = function(...) H.calls[#H.calls + 1] = { kind = 'log', args = { ... } } end,
    addCommand = function() end,
    versionCheck = function() end,
    locale = function(k) return k end,
    getFilesInDirectory = function() return {} end,
    waitFor = function(fn) return fn() end,
    table = {
        contains = function(t, v)
            for _, item in pairs(t or {}) do if item == v then return true end end
            return false
        end,
        deepclone = function(t)
            local function clone(v)
                if type(v) ~= 'table' then return v end
                local out = {}
                for k, item in pairs(v) do out[k] = clone(item) end
                return out
            end
            return clone(t)
        end,
        matches = function(a, b) return a == b end,
    },
    math = { round = function(n, places)
        local mult = 10 ^ (places or 0)
        return math.floor((tonumber(n) or 0) * mult + 0.5) / mult
    end },
    string = { random = function() return 'RANDOM' end },
}

-- Resources commonly call the bare global \`locale(key)\`; return the key so
-- assertions can match on it without loading real locale files.
function locale(key) return key end

-- ox_lib's require shim.
function require(path) return nil end
`;
