-- 9am-build CfxLua test framework
-- Jest/Busted-style API for AI-friendly unit tests without a FiveM server.

local M = {}

local suites = {}
local currentSuite = nil
local results = { passed = 0, failed = 0, failures = {} }

local function fail(message)
  error(message, 3)
end

local function quote(v)
  if type(v) == "string" then
    return string.format("%q", v)
  end
  return tostring(v)
end

local function deepEqual(a, b, seen)
  if a == b then return true end
  if type(a) ~= type(b) then return false end
  if type(a) ~= "table" then return false end

  seen = seen or {}
  if seen[a] then return seen[a] == b end
  seen[a] = b

  local aCount, bCount = 0, 0
  for k in pairs(a) do aCount = aCount + 1 end
  for k in pairs(b) do bCount = bCount + 1 end
  if aCount ~= bCount then return false end

  for k, v in pairs(a) do
    if not deepEqual(v, b[k], seen) then return false end
  end
  return true
end

function describe(name, fn)
  local suite = {
    name = name,
    tests = {},
    beforeEach = {},
    afterEach = {},
  }
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
  currentSuite.tests[#currentSuite.tests + 1] = { name = name, fn = fn }
end

function beforeEach(fn)
  assert(currentSuite, "beforeEach() must be called inside describe()")
  currentSuite.beforeEach[#currentSuite.beforeEach + 1] = fn
end

function afterEach(fn)
  assert(currentSuite, "afterEach() must be called inside describe()")
  currentSuite.afterEach[#currentSuite.afterEach + 1] = fn
end

local function makeExpect(actual)
  local chain = {}

  function chain.to_equal(expected)
    if actual ~= expected then
      fail(string.format("expected %s to equal %s", quote(actual), quote(expected)))
    end
  end

  function chain.to_be(expected)
    chain.to_equal(expected)
  end

  function chain.to_be_nil()
    if actual ~= nil then
      fail(string.format("expected %s to be nil", quote(actual)))
    end
  end

  function chain.to_be_truthy()
    if not actual then
      fail(string.format("expected %s to be truthy", quote(actual)))
    end
  end

  function chain.to_be_falsy()
    if actual then
      fail(string.format("expected %s to be falsy", quote(actual)))
    end
  end

  function chain.to_deep_equal(expected)
    if not deepEqual(actual, expected) then
      fail(string.format("expected %s to deep-equal %s", quote(actual), quote(expected)))
    end
  end

  function chain.to_contain(item)
    if type(actual) ~= "table" then
      fail("to_contain requires a table")
    end
    for _, v in pairs(actual) do
      if v == item then return end
    end
    fail(string.format("expected table to contain %s", quote(item)))
  end

  function chain.to_throw(expectedMessage)
    local ok, err = pcall(function()
      if type(actual) == "function" then
        actual()
      end
    end)
    if ok then
      fail("expected function to throw an error")
    end
    if expectedMessage and not tostring(err):find(expectedMessage, 1, true) then
      fail(string.format("expected error containing %q, got %s", expectedMessage, quote(err)))
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

function M.run()
  for _, suite in ipairs(suites) do
    for _, test in ipairs(suite.tests) do
      local testOk, testErr = xpcall(function()
        for _, hook in ipairs(suite.beforeEach) do hook() end
        test.fn()
      end, debug.traceback)

      -- afterEach must run even when the test body failed, otherwise cleanup
      -- (restoring mocked globals, etc.) leaks into every following test.
      local afterOk, afterErr = xpcall(function()
        for _, hook in ipairs(suite.afterEach) do hook() end
      end, debug.traceback)

      if testOk and afterOk then
        results.passed = results.passed + 1
        print(string.format("  \027[32m✓\027[0m %s > %s", suite.name, test.name))
      else
        results.failed = results.failed + 1
        local err = testOk and afterErr or testErr
        results.failures[#results.failures + 1] = {
          suite = suite.name,
          test = test.name,
          error = tostring(err),
        }
        print(string.format("  \027[31m✗\027[0m %s > %s", suite.name, test.name))
        print(err)
      end
    end
  end
  return results
end

function M.reset()
  suites = {}
  currentSuite = nil
  results = { passed = 0, failed = 0, failures = {} }
end

return M
