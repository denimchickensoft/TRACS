-- TRACS exporter - the DCS-side Lua of the relay's exporter capability.
--
-- A thin shim around Mods/Services/TRACS/bin/tracs_exporter.dll (source in
-- relay/native/), which does all the work: works out which side of the
-- connection this DCS is on, loads itself into the mission state on a host,
-- collects, schedules, buffers events and talks to a relay on this machine
-- (on a thread of its own). All that's left here is what DCS needs from Lua:
-- loading the DLL and handing it the callbacks. There is no Lua fallback:
-- without a working DLL nothing is collected.

-- Must match TRACS_EXPORTER_ABI in relay/native/common.h.
local DLL_ABI      = 7
local DEFAULT_PORT = 8767
local LOG_TAG      = 'TRACS.EXPORTER'

local function info(msg) log.write(LOG_TAG, log.INFO, msg) end
local function warn(msg) log.write(LOG_TAG, log.WARNING, msg) end
local function err(msg)  log.write(LOG_TAG, log.ERROR, msg) end

local DLL_DIR = lfs.writedir() .. [[Mods\Services\TRACS\bin\]]
local dll, dllLoadError
do
  package.cpath = package.cpath .. ';' .. DLL_DIR .. '?.dll'
  local ok, m = pcall(require, 'tracs_exporter')
  if not ok or type(m) ~= 'table' then
    dllLoadError = 'failed to load ' .. DLL_DIR .. 'tracs_exporter.dll: ' .. tostring(m)
  elseif m.abi ~= DLL_ABI then
    dllLoadError = string.format('tracs_exporter.dll is ABI %s, this hook needs %d - install both from the same relay',
      tostring(m.abi), DLL_ABI)
  else
    dll = m
  end
end

-- Only the relay port is configured on this side (everything else comes from
-- the relay's config.json): Saved Games/DCS/Config/tracs-exporter.lua may
-- return { port = 1234 }.
local function loadLocalConfig()
  local path = lfs.writedir() .. 'Config\\tracs-exporter.lua'
  local chunk = loadfile(path)
  if not chunk then return {} end
  local ok, cfg = pcall(chunk)
  if ok and type(cfg) == 'table' then return cfg end
  warn('ignoring unreadable ' .. path)
  return {}
end

local callbacks = {}

function callbacks.onMissionLoadEnd()
  if not dll then
    -- Without the DLL there's nothing to show the failure on screen but this.
    err('exporter not running: ' .. dllLoadError)
    if DCS.isServer() then
      pcall(net.dostring_in, 'server',
        string.format('trigger.action.outText(%q, 20)', 'TRACS Relay exporter failed to load: ' .. dllLoadError))
    end
    return
  end
  local ok, e = pcall(dll.missionLoad, { port = tonumber(loadLocalConfig().port) or DEFAULT_PORT, dllDir = DLL_DIR })
  if not ok then err('missionLoad: ' .. tostring(e)) end
end

-- A failing frame is logged once until it works again, not every frame.
local frameFailing = false

function callbacks.onSimulationFrame()
  if not dll then return end
  local ok, e = pcall(dll.frame)
  if not ok and not frameFailing then err('frame: ' .. tostring(e)) end
  frameFailing = not ok
end

function callbacks.onSimulationStop()
  if dll then pcall(dll.stop) end
end

DCS.setUserCallbacks(callbacks)
if dll then info('hook loaded, tracs_exporter.dll v' .. tostring(dll.version))
else err('hook loaded without its DLL - ' .. dllLoadError) end
