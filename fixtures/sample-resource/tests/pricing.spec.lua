local pricing = require('server.main')

describe('pricing.withTax', function()
  it('adds tax to the base price', function()
    expect(pricing.withTax(100, 0.2)).to.equal(120)
  end)

  it('handles zero tax', function()
    expect(pricing.withTax(50, 0)).to.equal(50)
  end)
end)

describe('pricing.buildNotify', function()
  it('builds a notify payload', function()
    expect(pricing.buildNotify('Shop', 'Welcome')).to.deep_equal({
      title = 'Shop',
      description = 'Welcome',
      type = 'inform',
    })
  end)
end)

describe('FiveM runtime stubs', function()
  it('exposes Citizen and TriggerEvent', function()
    expect(Citizen).to.be_truthy()
    expect(type(TriggerEvent)).to.equal('function')
  end)

  it('can spy on TriggerEvent', function()
    local spy = TestHelpers.spy()
    local restore = TestHelpers.mockGlobal('TriggerEvent', spy)
    TriggerEvent('test:event', 42)
    restore()
    expect(spy:call_count()).to.equal(1)
    expect(spy.calls[1][1]).to.equal('test:event')
    expect(spy.calls[1][2]).to.equal(42)
  end)
end)
