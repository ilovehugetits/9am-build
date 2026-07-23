-- CfxLua test harness core.
--
-- Pure Lua: knows nothing about JavaScript. The host injects two globals
-- before loading this chunk:
--   __readSource(relPath) -> string|nil   read a resource file from disk
--   __harness                             registry table (see runtime.ts)
--
-- Results are handed back as a JSON string so nothing depends on how the
-- host bridge happens to marshal Lua tables.

local H = rawget(_G, "__harness")

-- ============================================================
-- Value formatting
-- ============================================================

local function dump(v, seen, depth)
    seen = seen or {}
    depth = depth or 0
    local t = type(v)
    if t == 'string' then return string.format('%q', v) end
    if t == 'number' or t == 'boolean' or t == 'nil' then return tostring(v) end
    if t ~= 'table' then return '<' .. t .. '>' end
    if seen[v] then return '<cycle>' end
    if depth > 4 then return '{...}' end

    seen[v] = true
    local parts, n = {}, 0
    for i, item in ipairs(v) do
        parts[#parts + 1] = dump(item, seen, depth + 1)
        n = i
    end
    local keys = {}
    for k in pairs(v) do
        local isArrayIndex = type(k) == 'number' and k % 1 == 0 and k >= 1 and k <= n
        if not isArrayIndex then keys[#keys + 1] = k end
    end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    for _, k in ipairs(keys) do
        parts[#parts + 1] = string.format('%s = %s', tostring(k), dump(v[k], seen, depth + 1))
    end
    seen[v] = nil

    if #parts == 0 then return '{}' end
    return '{ ' .. table.concat(parts, ', ') .. ' }'
end

local function deepEqual(a, b)
    if a == b then return true end
    if type(a) ~= 'table' or type(b) ~= 'table' then return false end
    for k, v in pairs(a) do
        if not deepEqual(v, b[k]) then return false end
    end
    for k in pairs(b) do
        if a[k] == nil then return false end
    end
    return true
end

-- ============================================================
-- Assertions
-- ============================================================

-- Raised as a table so the reporter can print structured expected/actual
-- rather than parsing a formatted message back apart.
local function fail(assertion, expected, actual, message)
    error({
        __assert = true,
        assertion = assertion,
        expected = expected,
        actual = actual,
        message = message,
    }, 3)
end

local assertions = {}

function assertions.equal(expected, actual)
    if expected ~= actual then fail('assert.equal', dump(expected), dump(actual)) end
end

function assertions.not_equal(expected, actual)
    if expected == actual then fail('assert.not_equal', 'anything but ' .. dump(expected), dump(actual)) end
end

function assertions.same(expected, actual)
    if not deepEqual(expected, actual) then fail('assert.same', dump(expected), dump(actual)) end
end

function assertions.truthy(v)
    if not v then fail('assert.truthy', 'a truthy value', dump(v)) end
end

function assertions.falsy(v)
    if v then fail('assert.falsy', 'a falsy value', dump(v)) end
end

function assertions.has_error(fn, expected)
    local ok, err = pcall(fn)
    if ok then fail('assert.has_error', 'an error', 'no error raised') end
    if expected ~= nil then
        local got = type(err) == 'table' and (err.message or dump(err)) or tostring(err)
        if not string.find(got, tostring(expected), 1, true) then
            fail('assert.has_error', dump(expected), dump(got))
        end
    end
end

-- busted spells these `assert.are.equal` / `assert.are.same`.
assertions.are = { equal = assertions.equal, same = assertions.same }
assertions.is_true = assertions.truthy
assertions.is_nil = function(v) assertions.equal(nil, v) end

_G.assert = setmetatable(assertions, {
    __call = function(_, cond, msg)
        if not cond then error(msg or 'assertion failed!', 2) end
        return cond
    end,
})

-- ============================================================
-- Suite registry
-- ============================================================

local root = { name = nil, beforeEach = {}, afterEach = {} }
local stack = { root }
local tests = {}

function _G.describe(name, fn)
    stack[#stack + 1] = { name = name, beforeEach = {}, afterEach = {} }
    local ok, err = pcall(fn)
    table.remove(stack)
    if not ok then error(err, 0) end
end

_G.context = _G.describe

function _G.before_each(fn)
    local scope = stack[#stack]
    scope.beforeEach[#scope.beforeEach + 1] = fn
end

function _G.after_each(fn)
    local scope = stack[#stack]
    scope.afterEach[#scope.afterEach + 1] = fn
end

function _G.it(name, fn)
    local parts = {}
    for _, scope in ipairs(stack) do
        if scope.name then parts[#parts + 1] = scope.name end
    end
    parts[#parts + 1] = name

    -- Snapshot the hook chain as it stands now: hooks registered later in a
    -- sibling describe must not leak into this test.
    local before, after = {}, {}
    for i = 1, #stack do
        for _, f in ipairs(stack[i].beforeEach) do before[#before + 1] = f end
    end
    for i = #stack, 1, -1 do
        for _, f in ipairs(stack[i].afterEach) do after[#after + 1] = f end
    end

    local info = debug.getinfo(2, 'Sl')
    tests[#tests + 1] = {
        name = table.concat(parts, ' > '),
        line = info and info.currentline or 0,
        fn = fn,
        before = before,
        after = after,
    }
end

_G.test = _G.it
_G.pending = function(name) end

-- ============================================================
-- harness.* API
-- ============================================================

local base = nil

local function snapshotBase()
    base = {}
    for k, v in pairs(_G) do base[k] = v end
end

-- Restore _G to the pristine post-env state. Resource files define globals and
-- register handlers as a side effect of loading, so re-loading into a clean
-- table is the only way to make repeated tests independent.
local function resetGlobals()
    local current = {}
    for k in pairs(_G) do current[#current + 1] = k end
    for _, k in ipairs(current) do
        if base[k] == nil then rawset(_G, k, nil) end
    end
    for k, v in pairs(base) do rawset(_G, k, v) end

    for k in pairs(H.callbacks) do H.callbacks[k] = nil end
    for k in pairs(H.events) do H.events[k] = nil end
    for i = #H.threads, 1, -1 do H.threads[i] = nil end
    for i = #H.calls, 1, -1 do H.calls[i] = nil end
end

local harness = {}

function harness.load(...)
    resetGlobals()
    local files = { ... }
    for _, rel in ipairs(files) do
        local src = __readSource(rel)
        if not src then
            error('harness.load: file not found: ' .. tostring(rel), 2)
        end
        local chunk, err = load(src, '@' .. rel)
        if not chunk then
            error('harness.load: compile error in ' .. rel .. ': ' .. tostring(err), 2)
        end
        chunk()
    end
end

function harness.stub(name, value)
    rawset(_G, name, value)
end

function harness.callback(name, ...)
    local fn = H.callbacks[name]
    if not fn then
        error('harness.callback: no callback registered as ' .. tostring(name), 2)
    end
    return fn(...)
end

function harness.trigger(name, ...)
    local handlers = H.events[name]
    if not handlers or #handlers == 0 then
        error('harness.trigger: no handler registered for event ' .. tostring(name), 2)
    end
    local results = {}
    for _, fn in ipairs(handlers) do
        results[#results + 1] = fn(...)
    end
    return table.unpack(results)
end

-- Threads are recorded rather than run: resource code routinely wraps an
-- infinite `while true do ... end` loop in CreateThread at file scope, which
-- would hang the runner. Tests step them explicitly.
function harness.threads()
    return H.threads
end

function harness.runThread(index)
    local fn = H.threads[index or 1]
    if not fn then error('harness.runThread: no thread at index ' .. tostring(index or 1), 2) end
    return fn()
end

function harness.calls(kind)
    if not kind then return H.calls end
    local out = {}
    for _, c in ipairs(H.calls) do
        if c.kind == kind then out[#out + 1] = c end
    end
    return out
end

function harness.dump(v)
    return dump(v)
end

_G.harness = harness

-- ============================================================
-- JSON output
-- ============================================================

local ESCAPES = {
    ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b',
    ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}

local function jsonString(s)
    return '"' .. (tostring(s):gsub('[%z\1-\31"\\]', function(c)
        return ESCAPES[c] or string.format('\\u%04X', string.byte(c))
    end)) .. '"'
end

local function jsonValue(v)
    local t = type(v)
    if v == nil then return 'null' end
    if t == 'boolean' then return tostring(v) end
    if t == 'number' then
        if v ~= v or v == math.huge or v == -math.huge then return 'null' end
        return string.format('%.14g', v)
    end
    if t == 'string' then return jsonString(v) end
    if t == 'table' then
        if #v > 0 or next(v) == nil then
            local parts = {}
            for _, item in ipairs(v) do parts[#parts + 1] = jsonValue(item) end
            return '[' .. table.concat(parts, ',') .. ']'
        end
        local keys = {}
        for k in pairs(v) do keys[#keys + 1] = k end
        table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
        local parts = {}
        for _, k in ipairs(keys) do
            parts[#parts + 1] = jsonString(k) .. ':' .. jsonValue(v[k])
        end
        return '{' .. table.concat(parts, ',') .. '}'
    end
    return jsonString(tostring(v))
end

-- ============================================================
-- Runner
-- ============================================================

-- Drop frames belonging to the harness itself; they are noise to whoever is
-- reading the failure.
local function cleanTraceback(tb)
    local frames = {}
    for line in tostring(tb):gmatch('[^\n]+') do
        local frame = line:match('^%s*(.-)%s*$')
        if frame ~= ''
            and frame ~= 'stack traceback:'
            and frame ~= '(...tail calls...)'
            and not frame:find('harness.lua', 1, true)
            and not frame:find('[C]: in function \'xpcall\'', 1, true)
            and not frame:find('[C]: in function \'error\'', 1, true)
        then
            frames[#frames + 1] = frame
        end
    end
    return frames
end

local function messageHandler(err)
    -- debug.traceback returns a non-string message unchanged, which would
    -- discard a structured assertion error. Capture both separately instead.
    return { err = err, traceback = debug.traceback('', 2) }
end

function _G.__runTests(file)
    local results = {}

    for _, t in ipairs(tests) do
        for i = #H.unstubbed, 1, -1 do H.unstubbed[i] = nil end

        local started = os.clock()
        local ok, captured = xpcall(function()
            for _, f in ipairs(t.before) do f() end
            t.fn()
        end, messageHandler)

        -- after_each runs regardless, and its own failure is reported only if
        -- the test itself passed.
        local afterOk, afterCaptured = xpcall(function()
            for _, f in ipairs(t.after) do f() end
        end, messageHandler)

        if ok and not afterOk then
            ok, captured = afterOk, afterCaptured
        end

        local entry = {
            file = file,
            name = t.name,
            line = t.line,
            durationMs = math.floor((os.clock() - started) * 1000 + 0.5),
        }

        if ok then
            entry.status = 'pass'
        else
            local err = captured.err
            entry.traceback = cleanTraceback(captured.traceback)
            if type(err) == 'table' and err.__assert then
                entry.status = 'fail'
                entry.assertion = err.assertion
                entry.expected = err.expected
                entry.actual = err.actual
                entry.message = err.message
            else
                entry.status = 'error'
                entry.message = type(err) == 'table' and dump(err) or tostring(err)
            end

            local unstubbed = {}
            for _, u in ipairs(H.unstubbed) do
                unstubbed[#unstubbed + 1] = { name = u.name, at = u.at }
            end
            entry.unstubbed = unstubbed
        end

        results[#results + 1] = entry
    end

    return jsonValue(results)
end

snapshotBase()
