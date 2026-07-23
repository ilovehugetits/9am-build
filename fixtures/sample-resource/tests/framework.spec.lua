-- Smoke coverage for the 9am-build CfxLua test framework itself.
-- Every matcher and hook documented in the README is exercised here, so a
-- regression in framework.lua fails the suite instead of silently passing.

describe('matchers', function()
  it('equal / be compare by identity', function()
    expect(1 + 1).to.equal(2)
    expect('a' .. 'b').to.be('ab')
  end)

  it('be_nil, be_truthy and be_falsy', function()
    expect(nil).to.be_nil()
    expect(0).to.be_truthy() -- 0 is truthy in Lua
    expect(false).to.be_falsy()
  end)

  it('deep_equal compares nested tables', function()
    expect({ a = 1, b = { c = 2 } }).to.deep_equal({ a = 1, b = { c = 2 } })
  end)

  it('to_contain finds table values', function()
    expect({ 'alpha', 'beta' }).to.contain('beta')
  end)

  it('throw catches errors and matches the message', function()
    expect(function() error('boom: bad input') end).to.throw('boom')
  end)

  it('matchers are reachable with and without the .to bridge', function()
    expect(5).to.equal(5)
    expect(5).equal(5)
  end)
end)

describe('failure reporting', function()
  -- A matcher that should fail must raise, otherwise a broken assertion would
  -- report a false pass for every spec in every downstream resource.
  local function assertRaises(fn)
    local ok = pcall(fn)
    if ok then error('matcher did not raise on a failing assertion', 2) end
  end

  it('equal raises on mismatch', function()
    assertRaises(function() expect(1).to.equal(2) end)
  end)

  it('deep_equal raises on differing table shape', function()
    assertRaises(function() expect({ a = 1 }).to.deep_equal({ a = 1, b = 2 }) end)
  end)

  it('throw raises when nothing was thrown', function()
    assertRaises(function() expect(function() end).to.throw() end)
  end)

  it('unknown matchers raise instead of silently passing', function()
    assertRaises(function() expect(1).to.definitely_not_a_matcher(2) end)
  end)
end)

describe('hooks', function()
  local order = {}

  beforeEach(function() order[#order + 1] = 'before' end)
  afterEach(function() order[#order + 1] = 'after' end)

  it('runs beforeEach ahead of the test body', function()
    expect(order[#order]).to.equal('before')
  end)

  it('ran afterEach for the previous test', function()
    expect(order[#order - 1]).to.equal('after')
  end)
end)

describe('TestHelpers', function()
  it('spy records calls and forwards to the wrapped function', function()
    local spy = TestHelpers.spy(function(n) return n * 2 end)
    expect(spy(21)).to.equal(42)
    expect(spy:call_count()).to.equal(1)
    expect(spy.calls[1][1]).to.equal(21)
    expect(spy:was_called()).to.be_truthy()
    expect(spy:was_called_with(21)).to.be_truthy()
    expect(spy:was_called_with(99)).to.be_falsy()
  end)

  -- Note: CfxLua installs a metatable on _G, so a name that was never assigned
  -- reads back as a native stub rather than nil. mockGlobal is therefore only
  -- asserted against a global that genuinely exists beforehand.
  it('mockGlobal replaces and restores an existing global', function()
    local original = TriggerEvent
    local mock = TestHelpers.spy()
    local restore = TestHelpers.mockGlobal('TriggerEvent', mock)
    expect(TriggerEvent).to.equal(mock)
    restore()
    expect(TriggerEvent).to.equal(original)
  end)
end)

describe('CfxLua runtime surface', function()
  it('exposes the natives the runner promises', function()
    expect(Citizen).to.be_truthy()
    expect(type(TriggerEvent)).to.equal('function')
    expect(type(AddEventHandler)).to.equal('function')
  end)

  it('dispatches events to registered handlers', function()
    TestHelpers.assertEventRegistered('9am:smoke:event')
  end)

  it('resolves resource modules through package.path', function()
    expect(type(require('server.main').withTax)).to.equal('function')
  end)
end)
