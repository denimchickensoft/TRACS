-- Runs tracs_exporter.dll outside DCS for exporterDll.test.js:
--   lua.exe exporterHarness.lua <relay port> <seconds> <dll dir>
-- Stands in for the DCS globals the DLL's scheduler uses and registers a few
-- fake collectors, then drives frame() at roughly 100 Hz. Log lines go to
-- stdout as "LOG <level> <message>".
local port, seconds, dir = tonumber(arg[1]), tonumber(arg[2]), arg[3]
package.cpath = dir .. '\\?.dll;' .. package.cpath

local function out(...) io.write(...) io.write('\n') io.flush() end
local function sleep(s) local t = os.clock() + s while os.clock() < t do end end

log = {
  INFO = 'INFO', WARNING = 'WARNING', ERROR = 'ERROR',
  write = function(_, level, msg) out('LOG ', level, ' ', msg) end,
}
local t0 = os.clock()
DCS = { getModelTime = function() return os.clock() - t0 end }

local dll = require('tracs_exporter')
out('ABI ', dll.abi)

local n = 0
dll.register('fast', 'server', 1, false, function()
  n = n + 1
  return '{"n":' .. n .. '}'
end)

-- Finishes a cycle every third step.
local steps = 0
dll.register('sliced', 'server', 1, true, function(start, full, slices)
  steps = steps + 1
  if steps % 3 == 0 then return '{"steps":' .. steps .. '}', full and 'full' or 'delta', { extra = 7 }, { 100, 90 } end
  return nil, nil, nil, { 100, 100 }
end)

dll.register('clientOnly', 'client', 1, false, function() return '{"wrongSide":true}' end)
dll.register('once', 'server', 1, false, function() return '{"once":true}', true end)
dll.register('failing', 'server', 1, false, function() error('collector blew up') end)
-- A native (C) collector of the other side: listed in hello, never run here.
dll.registerNative('exportStatus', 'client', 5)
local ok, e = pcall(dll.registerNative, 'noSuchCollector', 'server', 1)
out('UNKNOWN NATIVE ', ok and 'accepted' or e)

-- Events as DCS would hand them to the mission's event handler.
local ev = 0
local function event()
  ev = ev + 1
  dll.onEvent(nil, { id = ev })
end

dll.start({
  port = port, side = 'server', multiplayer = true, theatre = 'Caucasus',
  status = '{"ok":true,"version":"test"}', ready = true,
})

local stopAt, frames = os.clock() + seconds, 0
while os.clock() < stopAt do
  dll.frame()
  frames = frames + 1
  if frames % 20 == 0 then event() end
  sleep(0.01)
end
dll.stop()
out('DONE')
