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
-- The client side's collectors and the server's units are the DLL's own
-- (registerNative); the other server collectors are still Lua for now,
-- called by the DLL's scheduler. There
-- is no Lua fallback: without a working DLL nothing is collected.

-- Must match TRACS_EXPORTER_ABI in relay/native/common.h.
local DLL_ABI         = 4
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
-- environment has no net.lua2json), the server-side collector functions and
-- an event ring buffer the hook drains.
local SERVER_BOOTSTRAP = [==[
-- Globals here outlive a mission change, so each mission starts from a clean
-- table; the previous mission's event handler is removed first.
if TRACS_EXP_S and TRACS_EXP_S.eventHandler then
  pcall(world.removeEventHandler, TRACS_EXP_S.eventHandler)
end
TRACS_EXP_S = {}
local S = TRACS_EXP_S

-- Lua heap size in KB, for the hook's per-step diagnostics (-1 if
-- collectgarbage isn't available here).
local function heapKb()
  if collectgarbage then return math.floor(collectgarbage('count')) end
  return -1
end

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
S.encode = encode

local function round(x, step) return math.floor(x / step + 0.5) * step end

-- Contacts: which enemy units each coalition's units detect, from DCS itself,
-- gathered a slice of the unit list per tick like units. Every red and blue
-- unit (or, with sensorUnitsOnly, only those whose type has sensors, checked
-- once per type) is asked for its detected targets once per detection
-- method, as Olympus does. Targets on the detector's own side are dropped;
-- the rest are merged per coalition into one flat map: '<coalition>:<target unit id>' -> the sum of
-- the method bits that found it (VISUAL 1, OPTIC 2, RADAR 4, IRST 8, RWR 16,
-- DLINK 32, Olympus's values). Flat, so the relay's one-level delta merge
-- works. The unit list is the DLL's units collector's (TRACS_DLL.activeUnits:
-- bare unit tables, so the Unit functions are called directly, not as
-- methods).
local DETECTION_BITS = { VISUAL = 1, OPTIC = 2, RADAR = 4, IRST = 8, RWR = 16, DLINK = 32 }
S.sensorTypes = {}
S.contactsSent = {}

-- A failed check counts as having sensors, so a unit is asked rather than
-- silently skipped.
local function hasSensors(e)
  local t = e.type or '?'
  local v = S.sensorTypes[t]
  if v == nil then
    local ok, r = pcall(Unit.hasSensors, e.u)
    v = (not ok) or r == true
    S.sensorTypes[t] = v
  end
  return v
end

local function hasBit(mask, bit) return math.floor(mask / bit) % 2 == 1 end

local function detectInto(e, acc)
  local ctrl = Unit.getController(e.u)
  if not ctrl then return end
  for name, method in pairs(Controller.Detection) do
    local bit = DETECTION_BITS[name]
    if bit then
      local targets = ctrl:getDetectedTargets(method) or {}
      for i = 1, #targets do
        local tgt = targets[i]
        local obj = tgt and tgt.visible and tgt.object
        if obj and Object.getCategory(obj) == Object.Category.UNIT then
          local side = obj:getCoalition()
          if side ~= e.side then
            local key = e.side .. ':' .. obj:getID()
            local m = acc[key] or 0
            if not hasBit(m, bit) then acc[key] = m + bit end
          end
        end
      end
    end
  end
end

-- Called a slice at a time like a sliced collector. Returns 'P|kbBefore|kbAfter' while
-- running, then '<F|D>|kbBefore|kbAfter|detectors|entries|changed|' and the
-- JSON object (a delta names changed entries, and lost ones as null).
function S.contactsStep(start, full, slices, sensorUnitsOnly)
  local kb0 = heapKb()
  slices = math.max(1, slices)
  if start or not S.cc then
    local list = TRACS_DLL.activeUnits()
    S.cc = { list = list, li = 1, full = full, acc = {}, detectors = 0,
      perStep = math.max(20, math.ceil(#list / slices)) }
  end
  local cc = S.cc
  local done = 0
  while done < cc.perStep and cc.list[cc.li] do
    local e = cc.list[cc.li]
    cc.li, done = cc.li + 1, done + 1
    if not sensorUnitsOnly or hasSensors(e) then
      cc.detectors = cc.detectors + 1
      pcall(detectInto, e, cc.acc)
    end
  end
  if cc.list[cc.li] then return 'P|' .. kb0 .. '|' .. heapKb() end

  local parts, changed, entries, sent = {}, 0, 0, S.contactsSent
  for key, m in pairs(cc.acc) do
    entries = entries + 1
    if cc.full or sent[key] ~= m then
      parts[#parts + 1] = encode(key) .. ':' .. encode(m)
      changed = changed + 1
    end
  end
  if not cc.full then
    for key in pairs(sent) do
      if cc.acc[key] == nil then
        parts[#parts + 1] = encode(key) .. ':null'
        changed = changed + 1
      end
    end
  end
  S.contactsSent, S.cc = cc.acc, nil
  return (cc.full and 'F' or 'D') .. '|' .. kb0 .. '|' .. heapKb() .. '|'
    .. cc.detectors .. '|' .. entries .. '|' .. changed .. '|{' .. table.concat(parts, ',') .. '}'
end

-- Live weather at every airdrome and carrier, a few airfields per tick:
-- pressure and temperature at the surface, wind 10 m above it, and wind and
-- temperature at the FD winds-aloft levels at least 1500 ft above the field.
-- Values go out raw (K, Pa, wind as the air's velocity in m/s on the map's
-- x north / z east axes); the backend turns them into QNH and from-directions.
-- Keyed by world.getAirbases index, as the airbases collector is.
local ALOFT_FT = { 3000, 6000, 9000, 12000, 18000, 24000, 30000, 34000, 39000 }
local ALOFT_MIN_ABOVE_M = 1500 * 0.3048
local WX_PER_STEP = 10
local wxPoint = { x = 0, y = 0, z = 0 }
S.wx = {}

local function sampleAt(x, y, z)
  wxPoint.x, wxPoint.y, wxPoint.z = x, y, z
  local t, p = atmosphere.getTemperatureAndPressure(wxPoint)
  local w = atmosphere.getWind(wxPoint)
  return t, p, w
end

local function sampleAirfield(e, parts)
  local ab = e.ab
  if not ab:isExist() then return end
  local pt = ab:getPoint()
  local elev = land.getHeight({ x = pt.x, y = pt.z })
  local t, p = sampleAt(pt.x, elev, pt.z)
  local _, _, w = sampleAt(pt.x, elev + 10, pt.z)
  local lat, lon = coord.LOtoLL(pt)
  local rec = {
    callsign = ab:getCallsign(), latitude = round(lat, 1e-6), longitude = round(lon, 1e-6),
    elevation = round(elev, 0.1), t = round(t, 0.01), p = round(p, 1),
    wx = round(w.x, 0.01), wz = round(w.z, 0.01), aloft = {},
  }
  local unit = ab:getUnit()
  if unit then rec.unitId = unit:getID() end
  for _, ft in ipairs(ALOFT_FT) do
    local alt = ft * 0.3048
    if alt >= elev + ALOFT_MIN_ABOVE_M then
      local at, _, aw = sampleAt(pt.x, alt, pt.z)
      rec.aloft[#rec.aloft + 1] = { ft = ft, t = round(at, 0.01), wx = round(aw.x, 0.01), wz = round(aw.z, 0.01) }
    end
  end
  -- An empty table would encode as [], which is still a valid aloft list.
  parts[#parts + 1] = encode(e.key) .. ':' .. encode(rec)
end

-- 0 when the mission's atmosphere is static (fixed for the whole mission),
-- 1 when dynamic (the mission editor's regimenStandard/regimenDynamic); a
-- mission without the field counts as dynamic.
local function atmosphereType()
  local w = env.mission and env.mission.weather
  return (w and w.atmosphere_type == 0) and 0 or 1
end

-- Airdromes and ships; FARPs and helipads aren't sampled.
local function wxBaseKind(ab)
  local cat = ab:getDesc().category
  if cat == Airbase.Category.AIRDROME then return 'airdrome' end
  if cat == Airbase.Category.SHIP then return 'ship' end
  return nil
end

-- 'P' while airfields are left, then '<atmosphereType>|<count>|<ships>|{json}'.
function S.airfieldWxStep(start)
  local w = S.wx
  if start or not w.list then
    w.list, w.i, w.parts, w.ships = {}, 0, {}, 0
    local bases = world.getAirbases() or {}
    for i = 1, #bases do
      local ok, kind = pcall(wxBaseKind, bases[i])
      if ok and kind then
        w.list[#w.list + 1] = { ab = bases[i], key = tostring(i) }
        if kind == 'ship' then w.ships = w.ships + 1 end
      end
    end
  end
  local last = math.min(#w.list, w.i + WX_PER_STEP)
  for j = w.i + 1, last do pcall(sampleAirfield, w.list[j], w.parts) end
  w.i = last
  if w.i < #w.list then return 'P' end
  local out = atmosphereType() .. '|' .. #w.parts .. '|' .. w.ships .. '|{' .. table.concat(w.parts, ',') .. '}'
  w.list, w.parts = nil, nil
  return out
end

local COALITION_NAMES = { [0] = 'neutral', [1] = 'red', [2] = 'blue' }

S.collectors = {
  -- Each coalition's bullseye, keyed by coalition id as a string.
  bullseyes = function()
    local out = {}
    for side = 0, 2 do
      local p = coalition.getMainRefPoint(side)
      if p then
        local lat, lon = coord.LOtoLL(p)
        out[tostring(side)] = { coalition = COALITION_NAMES[side], latitude = round(lat, 1e-6), longitude = round(lon, 1e-6) }
      end
    end
    return out
  end,
  -- Every airfield, FARP and carrier with its current owner, in the fields
  -- Olympus sends; unitId only for an airbase that is a unit (a ship).
  airbases = function()
    local out = {}
    local bases = world.getAirbases() or {}
    for i = 1, #bases do
      local ab = bases[i]
      local lat, lon = coord.LOtoLL(ab:getPoint())
      local info = {
        callsign = ab:getCallsign(), coalition = COALITION_NAMES[ab:getCoalition()] or 'neutral',
        latitude = round(lat, 1e-6), longitude = round(lon, 1e-6),
      }
      local unit = ab:getUnit()
      if unit then info.unitId = unit:getID() end
      out[tostring(i)] = info
    end
    return out
  end,
  -- Mission start date and the time of day, both theatre-local. absTime
  -- counts from midnight of the start date and passes 86400 after midnight,
  -- so the backend rolls the date forward from it.
  clock = function()
    return { date = env.mission and env.mission.date, absTime = timer.getAbsTime(), startTime = env.mission and env.mission.start_time }
  end,
  -- Fog as it is now (it can thicken and thin during a mission): visibility
  -- distance and layer thickness, metres. nil fields if this DCS version
  -- lacks the calls.
  fog = function()
    local out = {}
    pcall(function() out.visibility = world.weather.getFogVisibilityDistance() end)
    pcall(function() out.thickness = world.weather.getFogThickness() end)
    return out
  end,
}

-- Returns the collector's result as JSON text, or an error object.
function S.collect(name)
  local fn = S.collectors[name]
  if not fn then return '{"error":"unknown collector"}' end
  local ok, result = pcall(fn)
  if not ok then return encode({ error = tostring(result) }) end
  return encode(result)
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

-- Hands a collector to the DLL's scheduler. side: 'server' | 'client' |
-- 'both'. A plain gather() returns JSON text or nil, and optionally `once`.
-- A sliced one gets gather(start, full, slices, sensorUnitsOnly) once per
-- tick until it returns its result: json, kind ('full'|'delta'), a table of
-- extra timing fields, the mission state's {heapKbBefore, heapKbAfter}, and
-- `once` (true: don't run again until the next resync). Data goes out under
-- the collector's name, or `group` when given (a client collector feeding the
-- same group as its server counterpart).
local function register(name, side, rateS, gather, sliced, group)
  if dll then dll.register(name, side, rateS, sliced == true, gather, group) end
end

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

-- Units are the DLL's own collector (relay/native/server.c): it runs its
-- cycle in the mission state, calling DCS in a private Lua state.
if dll then dll.registerNative('units', 'server', 1) end

-- Each step also returns the mission-side heap size (KB) before and after it,
-- for the worst-step diagnostics in the DLL's timing lines.
register('contacts', 'server', 4, function(start, full, slices, sensorUnitsOnly)
  local r = inServer(string.format(
    'return TRACS_EXP_S and TRACS_EXP_S.contactsStep(%s, %s, %d, %s) or "E"',
    tostring(start), tostring(full), slices, tostring(sensorUnitsOnly == true)))
  if r == nil or r == 'E' then error('contacts step failed (mission environment not bootstrapped?)') end
  local p0, p1 = r:match('^P|(%-?%d+)|(%-?%d+)$')
  if p0 then return nil, nil, nil, { tonumber(p0), tonumber(p1) } end
  local kind, k0, k1, detectors, entries, changed, json =
    r:match('^(%a)|(%-?%d+)|(%-?%d+)|(%d+)|(%d+)|(%d+)|(.*)$')
  if not kind then error('unexpected contacts step result') end
  return json, kind == 'F' and 'full' or 'delta', {
    detectors = tonumber(detectors), entries = tonumber(entries), changed = tonumber(changed),
  }, { tonumber(k0), tonumber(k1) }
end, true)

-- Bullseyes rarely move (only when a script sets one), so a slow rate.
register('bullseyes', 'server', 30, function()
  return inServer('return TRACS_EXP_S and TRACS_EXP_S.collect("bullseyes") or "null"')
end)

-- Ownership changes only on capture.
register('airbases', 'server', 30, function()
  return inServer('return TRACS_EXP_S and TRACS_EXP_S.collect("airbases") or "null"')
end)

-- TRACS runs the clock locally between updates, so this only corrects drift,
-- e.g. after a pause.
register('clock', 'server', 15, function()
  return inServer('return TRACS_EXP_S and TRACS_EXP_S.collect("clock") or "null"')
end)

-- A cloud preset's layers and precipitation as DCS defines them
-- (Config/Effects/clouds.lua in the install): layer altitudes in metres for
-- the preset's default base, coverage 0..1+. Read from the file, so it
-- follows DCS updates. false when the file or preset can't be read.
local cloudPresets = {}
local function cloudPreset(name)
  if type(name) ~= 'string' then return false end
  if cloudPresets[name] ~= nil then return cloudPresets[name] end
  local result = false
  local ok, e = pcall(function()
    local dir = lfs.currentdir()
    if not dir:match('[/\\]$') then dir = dir .. '/' end
    local chunk = loadfile(dir .. 'Config/Effects/clouds.lua')
    if not chunk then return end
    -- The file only builds tables (its own deepcopy uses these few globals).
    local env = {
      _ = function(t) return t end, pairs = pairs, ipairs = ipairs, next = next, type = type,
      tostring = tostring, setmetatable = setmetatable, getmetatable = getmetatable,
      math = math, string = string, table = table,
    }
    setfenv(chunk, env)
    chunk()
    local p = env.clouds and env.clouds.presets and env.clouds.presets[name]
    if type(p) ~= 'table' then return end
    local layers = {}
    for i, l in ipairs(p.layers or {}) do
      layers[i] = { altitudeMin = l.altitudeMin, altitudeMax = l.altitudeMax, coverage = l.coverage }
    end
    result = { precipitationPower = p.precipitationPower, layers = layers }
  end)
  if not ok then warn('cloud preset ' .. name .. ' unreadable: ' .. tostring(e)) end
  cloudPresets[name] = result
  return result
end

-- The mission's weather table as the mission editor wrote it (QNH in mmHg,
-- visibility, clouds, fog, dust, the three wind layers...) plus its cloud
-- preset's layers. It never changes during a mission, so it's sent once per
-- resync.
register('weather', 'server', 600, function()
  local m = DCS.getCurrentMission()
  local w = m and m.mission and m.mission.weather
  if type(w) ~= 'table' then return nil end
  local preset = cloudPreset(w.clouds and w.clouds.preset)
  return toJson({ mission = w, cloudPreset = preset or nil }), true
end)

-- Fog can change during a mission (auto and manual fog animate).
register('fog', 'server', 60, function()
  return inServer('return TRACS_EXP_S and TRACS_EXP_S.collect("fog") or "null"')
end)

-- A static atmosphere is fixed for the whole mission, so it's sampled once
-- per resync; a dynamic one is re-sampled at the collector's rate.
register('airfieldWeather', 'server', 600, function(start)
  local r = inServer(string.format('return TRACS_EXP_S and TRACS_EXP_S.airfieldWxStep(%s) or "E"', tostring(start)))
  if r == nil or r == 'E' then error('airfieldWeather step failed (mission environment not bootstrapped?)') end
  if r == 'P' then return nil end
  local atm, n, ships, json = r:match('^(%d)|(%d+)|(%d+)|(.*)$')
  if not atm then error('unexpected airfieldWeather step result') end
  local static = atm == '0'
  return json, 'full', { airfields = tonumber(n), ships = tonumber(ships), static = static }, nil, static
end, true)

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
