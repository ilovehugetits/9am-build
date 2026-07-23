local M = {}

--- Adds a tax rate to a base price.
---@param price number
---@param rate number fraction, e.g. 0.2 for 20%
---@return number
function M.withTax(price, rate)
  return price + (price * rate)
end

--- Formats a player notification payload.
---@param title string
---@param message string
---@return table
function M.buildNotify(title, message)
  return {
    title = title,
    description = message,
    type = 'inform',
  }
end

return M
