-- Fixture resource under test. Deliberately contains a bug on line 12.

function addTax(amount, rate)
    return amount + (amount * rate)
end

function classify(price)
    if price > 100000 then
        return 'luxury'
    elseif price > 30000 then
        -- BUG: returns nil instead of 'mid', used to prove failure reporting
        return nil
    end
    return 'budget'
end

function needsNative()
    return GetVehicleNumberPlateText(1)
end

lib.callback.register('fixture:buy', function(source, data)
    if not data or not data.model then
        return { success = false, message = 'invalid' }
    end
    return { success = true, model = data.model }
end)
