-- TRACS exporter - the DCS-side Lua of the relay's exporter capability.
--
-- A thin shim around Mods/Services/TRACS/bin/tracs_exporter.dll (source in
-- relay/native/), which does the work: the connection to a relay on this
-- machine (on a thread of its own), scheduling, demand, events and timings.
-- The DLL is loaded into this hook state on every DCS instance and, on a
-- host, into the mission state too, where it calls DCS's functions in a
-- private Lua state so their garbage never lands in a shared one.
--
-- Works out which side of the connection it is on:
--   server: DCS.isServer() (dedicated server, hosted MP, single player). Data
--           is gathered inside the mission scripting environment.
--   client: a multiplayer client. Only what the DCS Export API allows under
--           the host's export permissions is available.
--
-- Every collector is the DLL's own (registerNative); the mission state only
-- keeps a small event handler from here. There is no Lua fallback: without a
-- working DLL nothing is collected.

-- Must match TRACS_EXPORTER_ABI in relay/native/common.h.
local DLL_ABI         = 6
local DEFAULT_PORT    = 8767
local LOG_TAG         = 'TRACS.EXPORTER'

local function info(msg)  log.write(LOG_TAG, log.INFO, msg) end
local function warn(msg)  log.write(LOG_TAG, log.WARNING, msg) end
local function err(msg)   log.write(LOG_TAG, log.ERROR, msg) end

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

local function now() return DCS.getRealTime() end

local function toJson(v)
  local ok, s = pcall(net.lua2json, v)
  if ok then return s end
  return nil
end

local function fromJson(s)
  local ok, v = pcall(net.json2lua, s)
  if ok then return v end
  return nil
end

---------------------------------------------------------------------------
-- Collectors
---------------------------------------------------------------------------

-- Injected into the mission scripting environment once per mission (server
-- side only). Defines TRACS_EXP_S with its own JSON encoder (the mission
-- environment has no net.lua2json) and an event ring buffer the hook drains;
-- birth events also go to the DLL's units collector.
local SERVER_BOOTSTRAP = [==[
-- Globals here outlive a mission change, so each mission starts from a clean
-- table; the previous mission's event handler is removed first.
if TRACS_EXP_S and TRACS_EXP_S.eventHandler then
  pcall(world.removeEventHandler, TRACS_EXP_S.eventHandler)
end
TRACS_EXP_S = {}
local S = TRACS_EXP_S

local function encode(v)
  local t = type(v)
  if v == nil then return 'null'
  elseif t == 'boolean' then return tostring(v)
  elseif t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then return 'null' end
    return string.format('%.8g', v)
  elseif t == 'string' then
    return '"' .. v:gsub('[%c"\\]', function(c)
      if c == '"' then return '\\"' elseif c == '\\' then return '\\\\'
      elseif c == '\n' then return '\\n' else return string.format('\\u%04x', c:byte()) end
    end) .. '"'
  elseif t == 'table' then
    if #v > 0 or next(v) == nil then
      local parts = {}
      for i = 1, #v do parts[i] = encode(v[i]) end
      return '[' .. table.concat(parts, ',') .. ']'
    end
    local parts = {}
    for k, val in pairs(v) do
      parts[#parts + 1] = encode(tostring(k)) .. ':' .. encode(val)
    end
    return '{' .. table.concat(parts, ',') .. '}'
  end
  return 'null'
end

-- Drained by the hook every second; sized for a heavy mission's spawn burst.
S.events, S.eventCap = {}, 5000
S.eventHandler = {}
function S.eventHandler:onEvent(e)
  local rec = { id = e.id, time = e.time }
  pcall(function() if e.initiator then rec.initiator = e.initiator:getName() end end)
  if e.id == world.event.S_EVENT_BIRTH and e.initiator then pcall(TRACS_DLL.onBirth, e.initiator) end
  S.events[#S.events + 1] = rec
  while #S.events > S.eventCap do table.remove(S.events, 1) end
end
world.addEventHandler(S.eventHandler)

-- Hands the buffered events to the hook and clears them.
function S.drainEvents()
  if #S.events == 0 then return '[]' end
  local out = encode(S.events)
  S.events = {}
  return out
end

return 'ok'
]==]

local C = {
  side = nil,  -- 'server' | 'client'
  dll  = nil,  -- this mission's DLL status, see initDll
}

local function inServer(code)
  local ok, result = pcall(net.dostring_in, 'server', code)
  if ok then return result end
  return nil
end

-- Loads the DLL into the mission state (the 'server' environment still has
-- require) and runs its init there, which also shows the loaded/failed
-- message on screen. %q is the DLL folder.
local DLL_SERVER_INIT = [==[
if not TRACS_DLL then
  if not package then return 'ERR no package library in the mission environment' end
  package.cpath = package.cpath .. ';' .. %q .. '?.dll'
  local ok, m = pcall(require, 'tracs_exporter')
  if not ok or type(m) ~= 'table' then
    local msg = 'failed to load tracs_exporter.dll in the mission environment: ' .. tostring(m)
    pcall(trigger.action.outText, 'TRACS Relay exporter ' .. msg, 20)
    return 'ERR ' .. msg
  end
  TRACS_DLL = m
end
local ok, e = TRACS_DLL.initServer()
if ok then return 'ok' end
return 'ERR ' .. tostring(e)
]==]

-- Per-mission DLL init for this side: { ok, version, error, selfTest }.
-- On a host the mission side's self-test result comes back through the
-- DLL's own memory (take), not through dostring_in, which checks that the
-- two loaded copies really share it.
local function initDll()
  if not dll then return { ok = false, error = dllLoadError } end
  local status = { ok = false, version = dll.version }
  if C.side == 'client' then
    local ok, r = dll.initClient()
    if not ok then status.error = r return status end
    local p = fromJson(r)
    status.ok, status.selfTest = true, p and p.selfTest
    status.pending = status.selfTest ~= nil and status.selfTest.pending == true
    return status
  end
  dll.take()
  local r = inServer(string.format(DLL_SERVER_INIT, DLL_DIR))
  if r ~= 'ok' then
    status.error = r and r:gsub('^ERR ', '') or 'mission environment unreachable'
    return status
  end
  local posted = dll.take()
  if not posted then
    status.error = 'no hand-off from the mission side - the two loaded copies of tracs_exporter.dll do not share memory'
    return status
  end
  local p = fromJson(posted)
  status.ok, status.selfTest = true, p and p.selfTest
  return status
end

local function dllReady() return C.dll ~= nil and C.dll.ok and not C.dll.pending end

local function logDllStatus()
  if C.dll.ok and C.dll.pending then
    info('tracs_exporter.dll v' .. tostring(C.dll.version) .. ' loaded - self-test waits for world objects')
  elseif C.dll.ok then
    local st = C.dll.selfTest or {}
    info(string.format('tracs_exporter.dll v%s ready - self-test %s passed, %s skipped, %s', tostring(C.dll.version),
      tostring(st.passed), tostring(st.skipped), tostring(st.subject)))
  else
    err('exporter not collecting: ' .. tostring(C.dll.error))
  end
end

-- A client's world is usually empty at mission load, so its self-test is
-- repeated once a second until there are objects to compare; nothing is
-- collected meanwhile.
local DLL_RETRY_S = 1
local dllRetryAt = 0

local function retryPendingDll()
  local t = now()
  if not (C.dll and C.dll.pending) or t < dllRetryAt then return end
  dllRetryAt = t + DLL_RETRY_S
  C.dll = initDll()
  if not C.dll.pending then
    logDllStatus()
    dll.setStatus(toJson(C.dll), dllReady())
  end
end

-- Server side: the DLL's own collectors (relay/native/server.c and
-- serverlow.c). They run in the mission state, calling DCS in a private Lua
-- state. Contacts use the units collector's list of active units. Rates:
-- bullseyes rarely move (only when a script sets one); airbase ownership
-- changes only on capture; TRACS runs the clock locally between updates, so
-- it only corrects drift; fog animates; the mission weather never changes
-- and goes once per resync; airfieldWeather goes once per resync in a static
-- atmosphere and is re-sampled at its rate in a dynamic one.
if dll then
  dll.registerNative('units', 'server', 1)
  dll.registerNative('contacts', 'server', 4)
  dll.registerNative('bullseyes', 'server', 30)
  dll.registerNative('airbases', 'server', 30)
  dll.registerNative('clock', 'server', 15)
  dll.registerNative('weather', 'server', 600)
  dll.registerNative('fog', 'server', 60)
  dll.registerNative('airfieldWeather', 'server', 600)
end

-- Client side: the DLL's own collectors (relay/native/client.c), in the
-- same groups as the server side's. units_client reads the export API's
-- world objects in the DLL's private Lua state; bullseyes come from the
-- mission file (a script moving one isn't visible to a client).
if dll then
  dll.registerNative('units_client', 'client', 1, 'units')
  dll.registerNative('exportStatus', 'client', 5)
  dll.registerNative('bullseyes_client', 'client', 30, 'bullseyes')
  dll.registerNative('airbases_client', 'client', 30, 'airbases')
  dll.registerNative('clock_client', 'client', 15, 'clock')
end

-- Events buffered in the mission environment, for the DLL to collect (it
-- asks once a second on a host, while idle too).
if dll then
  dll.setEventSource(function()
    return inServer('return TRACS_EXP_S and TRACS_EXP_S.drainEvents() or "[]"')
  end)
end

---------------------------------------------------------------------------
-- DCS callbacks
---------------------------------------------------------------------------

local callbacks = {}

function callbacks.onMissionLoadEnd()
  local ok, e = pcall(function()
    C.side = DCS.isServer() and 'server' or 'client'
    local port = tonumber(loadLocalConfig().port) or DEFAULT_PORT
    if not dll then
      err('exporter not running: ' .. dllLoadError)
      if C.side == 'server' then
        inServer(string.format('trigger.action.outText(%q, 20)', 'TRACS Relay exporter failed to load: ' .. dllLoadError))
      end
      return
    end
    C.dll = initDll()
    dllRetryAt = 0
    logDllStatus()
    if C.side == 'server' and C.dll.ok then
      local r = inServer(SERVER_BOOTSTRAP)
      if r ~= 'ok' then err('mission environment bootstrap failed: ' .. tostring(r)) end
    end
    local mission = DCS.getCurrentMission()
    dll.start({
      port = port, side = C.side, multiplayer = DCS.isMultiplayer(),
      theatre = mission and mission.mission and mission.mission.theatre,
      status = toJson(C.dll), ready = dllReady(),
    })
    info('mission loaded - side=' .. C.side .. ', relay port ' .. port)
  end)
  if not ok then err('onMissionLoadEnd: ' .. tostring(e)) end
end

-- A failing frame is logged once until it works again, not every frame.
local frameFailing = false

function callbacks.onSimulationFrame()
  if not dll or not C.side then return end
  if C.dll and C.dll.pending then
    local ok, e = pcall(retryPendingDll)
    if not ok then err('client self-test retry: ' .. tostring(e)) end
  end
  local ok, e = pcall(dll.frame)
  if not ok and not frameFailing then err('frame: ' .. tostring(e)) end
  frameFailing = not ok
end

function callbacks.onSimulationStop()
  if dll then pcall(dll.stop) end
  C.side, C.dll = nil, nil
end

DCS.setUserCallbacks(callbacks)
if dll then info('hook loaded, tracs_exporter.dll v' .. tostring(dll.version))
else err('hook loaded without its DLL - ' .. dllLoadError) end
