/**
 * oxmysql stubs. Every query is recorded (retrievable via `harness.calls('sql')`)
 * and returns an empty result by default; tests override with `harness.stub`
 * when they need specific rows back.
 */
export const OXMYSQL_ENV_LUA = `
local H = rawget(_G, "__harness")

local function record(kind, sql, params)
    H.calls[#H.calls + 1] = { kind = 'sql', op = kind, sql = sql, params = params }
end

-- Each MySQL.<op> is callable directly (async form, taking a trailing
-- callback) and via .await (synchronous form). Both record identically.
local function makeOp(kind, default)
    return setmetatable({
        await = function(sql, params)
            record(kind, sql, params)
            return default()
        end,
    }, {
        __call = function(_, sql, params, cb)
            record(kind, sql, params)
            local result = default()
            if type(params) == 'function' then params(result) end
            if type(cb) == 'function' then cb(result) end
            return result
        end,
    })
end

MySQL = {
    query = makeOp('query', function() return {} end),
    single = makeOp('single', function() return nil end),
    scalar = makeOp('scalar', function() return nil end),
    insert = makeOp('insert', function() return 1 end),
    update = makeOp('update', function() return 0 end),
    prepare = makeOp('prepare', function() return {} end),
    transaction = makeOp('transaction', function() return true end),
    rawExecute = makeOp('rawExecute', function() return {} end),
    ready = function(fn) if type(fn) == 'function' then fn() end end,
}

exports.oxmysql = MySQL
`;
