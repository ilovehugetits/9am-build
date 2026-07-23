describe('addTax', function()
    before_each(function()
        harness.load('logic.lua')
    end)

    it('applies a percentage rate', function()
        assert.equal(110, addTax(100, 0.1))
    end)

    it('classifies a mid-range price', function()
        assert.equal('mid', classify(50000))
    end)

    it('surfaces an unstubbed native', function()
        assert.equal('ABC123', needsNative())
    end)
end)

describe('fixture:buy callback', function()
    before_each(function()
        harness.load('logic.lua')
    end)

    it('rejects a payload with no model', function()
        local res = harness.callback('fixture:buy', 1, {})
        assert.falsy(res.success)
    end)

    it('accepts a valid payload', function()
        local res = harness.callback('fixture:buy', 1, { model = 'adder' })
        assert.truthy(res.success)
        assert.equal('adder', res.model)
    end)
end)
