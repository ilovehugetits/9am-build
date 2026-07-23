-- 9am-build CfxLua test framework
-- Jest/Busted-style API for AI-friendly unit tests without a FiveM server.
--
-- Results are emitted as a JSON payload rather than printed as pretty checkmark
-- lines: the TypeScript side owns rendering, so it can resolve source excerpts,
-- emit --json, and keep every location a `path:line` anchor.

local M = {}

local suites = {}
local currentSuite = nil
local results = { passed = 0, failed = 0, failures = {}, tests = {} }

-- ============================================================
-- Value formatting
-- ============================================================

local function quote(v)
  if type(v) == "string" then
    return string.format("%q", v)
  end
  return tostring(v)
end

local function dump(v, seen, depth)
  seen = seen or {}
  depth = depth or 0
  if type(v) ~= "table" then return quote(v) end
  if seen[v] then return "<cycle>" end
  if depth > 4 then return "{...}" end

  seen[v] = true
  local parts, n = {}, 0
  for i, item in ipairs(v) do
    parts[#parts + 1] = dump(item, seen, depth + 1)
    n = i
  end
  local keys = {}
  for k in pairs(v) do
    local isArrayIndex = type(k) == "number" and k % 1 == 0 and k >= 1 and k <= n
    if not isArrayIndex then keys[#keys + 1] = k end
  end
  table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
  for _, k in ipairs(keys) do
    parts[#parts + 1] = string.format("%s = %s", tostring(k), dump(v[k], seen, depth + 1))
  end
  seen[v] = nil

  if #parts == 0 then return "{}" end
  return "{ " .. table.concat(parts, ", ") .. " }"
end

local function deepEqual(a, b, seen)
  if a == b then return true end
  if type(a) ~= type(b) then return false end
  if type(a) ~= "table" then return false end

  seen = seen or {}
  if seen[a] then return seen[a] == b end
  seen[a] = b

  local aCount, bCount = 0, 0
  for _ in pairs(a) do aCount = aCount + 1 end
  for _ in pairs(b) do bCount = bCount + 1 end
  if aCount ~= bCount then return false end

  for k, v in pairs(a) do
    if not deepEqual(v, b[k], seen) then return false end
  end
  return true
end

-- ============================================================
-- Failures
-- ============================================================

-- Raised as a table so the reporter can print structured expected/actual
-- instead of parsing a formatted sentence back apart. Anything that pcalls a
-- failing matcher still sees a falsy result, so specs asserting "this matcher
-- raises" keep working unchanged.
local function fail(matcher, expected, actual, message)
  error({
    __expect = true,
    matcher = matcher,
    expected = expected,
    actual = actual,
    message = message,
  }, 3)
end

-- ============================================================
-- Suite registry
-- ============================================================

function describe(name, fn)
  local suite = { name = name, tests = {}, beforeEach = {}, afterEach = {} }
  suites[#suites + 1] = suite
  local prev = currentSuite
  currentSuite = suite
  local ok, err = xpcall(fn, debug.traceback)
  currentSuite = prev
  if not ok then
    error("describe('" .. name .. "') failed: " .. tostring(err), 2)
  end
end

function it(name, fn)
  assert(currentSuite, "it() must be called inside describe()")
  local info = debug.getinfo(2, "Sl")
  currentSuite.tests[#currentSuite.tests + 1] = {
    name = name,
    fn = fn,
    source = info and info.short_src or "?",
    line = info and info.currentline or 0,
  }
end

function beforeEach(fn)
  assert(currentSuite, "beforeEach() must be called inside describe()")
  currentSuite.beforeEach[#currentSuite.beforeEach + 1] = fn
end

function afterEach(fn)
  assert(currentSuite, "afterEach() must be called inside describe()")
  currentSuite.afterEach[#currentSuite.afterEach + 1] = fn
end

-- ============================================================
-- Matchers
-- ============================================================

local function makeExpect(actual)
  local chain = {}

  function chain.to_equal(expected)
    if actual ~= expected then fail("equal", quote(expected), quote(actual)) end
  end

  function chain.to_be(expected)
    chain.to_equal(expected)
  end

  function chain.to_be_nil()
    if actual ~= nil then fail("be_nil", "nil", quote(actual)) end
  end

  function chain.to_be_truthy()
    if not actual then fail("be_truthy", "a truthy value", quote(actual)) end
  end

  function chain.to_be_falsy()
    if actual then fail("be_falsy", "a falsy value", quote(actual)) end
  end

  function chain.to_deep_equal(expected)
    if not deepEqual(actual, expected) then
      fail("deep_equal", dump(expected), dump(actual))
    end
  end

  function chain.to_contain(item)
    if type(actual) ~= "table" then
      fail("contain", "a table", quote(actual), "to_contain requires a table")
    end
    for _, v in pairs(actual) do
      if v == item then return end
    end
    fail("contain", "a table containing " .. quote(item), dump(actual))
  end

  function chain.to_throw(expectedMessage)
    local ok, err = pcall(function()
      if type(actual) == "function" then actual() end
    end)
    if ok then
      fail("throw", "an error", "no error raised")
    end
    if expectedMessage then
      local text = type(err) == "table" and (err.message or dump(err)) or tostring(err)
      if not text:find(expectedMessage, 1, true) then
        fail("throw", "an error containing " .. quote(expectedMessage), quote(text))
      end
    end
  end

  return setmetatable({}, {
    __index = function(_, key)
      if key == "to" then
        return setmetatable({}, {
          __index = function(_, method)
            local fn = chain["to_" .. method]
            assert(fn, "unknown matcher: to." .. method)
            return fn
          end,
        })
      end
      local fn = chain["to_" .. key]
      assert(fn, "unknown matcher: " .. key)
      return fn
    end,
  })
end

function expect(actual)
  return makeExpect(actual)
end

-- ============================================================
-- JSON output
-- ============================================================

local ESCAPES = {
  ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b",
  ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t",
}

local function jsonString(s)
  return '"' .. (tostring(s):gsub('[%z\1-\31"\\]', function(c)
    return ESCAPES[c] or string.format("\\u%04X", string.byte(c))
  end)) .. '"'
end

local function jsonValue(v)
  local t = type(v)
  if v == nil then return "null" end
  if t == "boolean" then return tostring(v) end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    return string.format("%.14g", v)
  end
  if t == "string" then return jsonString(v) end
  if t == "table" then
    if #v > 0 or next(v) == nil then
      local parts = {}
      for _, item in ipairs(v) do parts[#parts + 1] = jsonValue(item) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local parts = {}
    for _, k in ipairs(keys) do
      parts[#parts + 1] = jsonString(k) .. ":" .. jsonValue(v[k])
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return jsonString(tostring(v))
end

M.encodeJson = jsonValue

-- ============================================================
-- Runner
-- ============================================================

-- Frames inside the framework itself are noise to whoever reads the failure.
local function cleanTraceback(tb)
  local frames = {}
  for line in tostring(tb):gmatch("[^\n]+") do
    local frame = line:match("^%s*(.-)%s*$")
    if frame ~= ""
      and frame ~= "stack traceback:"
      and frame ~= "(...tail calls...)"
      and not frame:find("framework.lua", 1, true)
      and not frame:find("runner.lua", 1, true)
      -- CfxLua's own scheduler/bootstrap frames sit under every test and say
      -- nothing about the resource under test.
      and not frame:find("bootstrap.lua", 1, true)
      and not frame:find("scheduler.lua", 1, true)
      and not frame:find("[C]: in function 'xpcall'", 1, true)
      and not frame:find("[C]: in function 'error'", 1, true)
    then
      frames[#frames + 1] = frame
    end
  end
  return frames
end

local function messageHandler(err)
  -- debug.traceback returns a non-string message unchanged, which would
  -- discard a structured matcher failure. Capture both separately.
  return { err = err, traceback = debug.traceback("", 2) }
end

function M.run()
  for _, suite in ipairs(suites) do
    for _, test in ipairs(suite.tests) do
      local started = os.clock()

      local testOk, testCaptured = xpcall(function()
        for _, hook in ipairs(suite.beforeEach) do hook() end
        test.fn()
      end, messageHandler)

      -- afterEach must run even when the test body failed, otherwise cleanup
      -- (restoring mocked globals, etc.) leaks into every following test.
      local afterOk, afterCaptured = xpcall(function()
        for _, hook in ipairs(suite.afterEach) do hook() end
      end, messageHandler)

      local entry = {
        suite = suite.name,
        test = test.name,
        name = suite.name .. " > " .. test.name,
        file = test.source,
        line = test.line,
        durationMs = math.floor((os.clock() - started) * 1000 + 0.5),
      }

      if testOk and afterOk then
        results.passed = results.passed + 1
        entry.status = "pass"
      else
        results.failed = results.failed + 1
        local captured = testOk and afterCaptured or testCaptured
        local err = captured.err
        entry.traceback = cleanTraceback(captured.traceback)

        if type(err) == "table" and err.__expect then
          entry.status = "fail"
          entry.matcher = err.matcher
          entry.expected = err.expected
          entry.actual = err.actual
          entry.message = err.message
        else
          entry.status = "error"
          entry.message = type(err) == "table" and dump(err) or tostring(err)
        end

        results.failures[#results.failures + 1] = {
          suite = suite.name,
          test = test.name,
          error = entry.message or "",
        }
      end

      results.tests[#results.tests + 1] = entry
    end
  end
  return results
end

function M.reset()
  suites = {}
  currentSuite = nil
  results = { passed = 0, failed = 0, failures = {}, tests = {} }
end

return M
