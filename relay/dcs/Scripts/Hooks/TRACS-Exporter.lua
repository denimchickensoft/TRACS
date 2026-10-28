-- TRACS exporter - DCS-side half of the relay's exporter capability.
--
-- Runs in the DCS hooks (GUI) environment on every DCS instance and works out
-- which side of the connection it is on:
--   server: DCS.isServer() (dedicated server, hosted MP, single player). Data
--           is gathered inside the mission scripting environment by code this
--           hook injects with net.dostring_in('server', ...), which hands each
--           result back as a JSON string.
--   client: a multiplayer client. Only what the DCS Export API allows under
--           the host's export permissions is available.
--
-- Everything goes to a relay on this machine over one localhost TCP
-- connection, as newline-delimited JSON. The relay decides when anything is
-- gathered at all: collectors only run while it reports at least one
-- subscriber (a "demand" message), so an idle server pays only for an
-- occasional reconnect attempt.
--
-- Two layers, kept apart so a native DLL could later replace the transport
-- without touching the collectors:
--   Transport  - socket, send buffering, config/demand state, event buffer.
--   Collectors - the gathering itself, which must stay on the sim thread
--                because the DCS scripting API can only be called from it.
-- They meet only through T.isAwake/send/pushEvent/onConfig/onResync.

local HOOK_PROTOCOL   = 1
local DEFAULT_PORT    = 8767
-- The tick is finer than any data rate so work can be spread across ticks
-- (and large sends drain promptly); no collector runs more often than once a
-- second, the fastest rate anything in TRACS consumes.
local TICK_INTERVAL_S = 0.1
-- Default size of the mission-side incremental GC step per tick (KB of
-- allocation's worth of work; 0 = off). The relay's exporter.gcStepKb
-- overrides it.
local DEFAULT_GC_STEP_KB = 200
local MIN_RATE_S      = 1
local CONNECT_TIMEOUT_S = 2
local BACKOFF_MIN_S   = 2
local BACKOFF_MAX_S   = 30
local MAX_TX_BYTES    = 8 * 1024 * 1024
local LOG_TAG         = 'TRACS.EXPORTER'

local function info(msg)  log.write(LOG_TAG, log.INFO, msg) end
local function warn(msg)  log.write(LOG_TAG, log.WARNING, msg) end
local function err(msg)   log.write(LOG_TAG, log.ERROR, msg) end

package.path  = package.path .. ';.\\LuaSocket\\?.lua;'
package.cpath = package.cpath .. ';.\\LuaSocket\\?.dll;'
local socket = require('socket')

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
-- Transport
---------------------------------------------------------------------------

local T = {
  port        = DEFAULT_PORT,
  state       = 'idle',     -- idle | connecting | connected
  tcp         = nil,
  connectAt   = 0,
  retryAt     = 0,
  backoff     = BACKOFF_MIN_S,
  rx          = '',
  tx          = {},
  txBytes     = 0,
  awake       = false,
  config      = nil,
  events      = {},
  eventCap    = 2000,
  droppedEvents = 0,
  configCbs   = {},
  resyncCbs   = {},
  helloFn     = nil,
}

function T.isAwake() return T.state == 'connected' and T.awake end

function T.onConfig(cb) T.configCbs[#T.configCbs + 1] = cb end
function T.onResync(cb) T.resyncCbs[#T.resyncCbs + 1] = cb end

-- Queues one already-encoded line. `line` must be a single JSON object with
-- no newlines.
local function queueLine(line)
  if T.txBytes + #line + 1 > MAX_TX_BYTES then
    warn('send buffer full - dropping a message (relay not keeping up?)')
    return false
  end
  T.tx[#T.tx + 1] = line .. '\n'
  T.txBytes = T.txBytes + #line + 1
  return true
end

-- `json` is the payload already encoded as JSON text, so data gathered in the
-- mission environment is forwarded without a decode/re-encode round trip.
function T.send(group, kind, seq, json)
  if T.state ~= 'connected' then return false end
  return queueLine('{"type":"data","v":' .. HOOK_PROTOCOL
    .. ',"group":' .. toJson(group)
    .. ',"kind":"' .. kind .. '"'
    .. ',"seq":' .. seq
    .. ',"t":' .. string.format('%.3f', DCS.getModelTime())
    .. ',"data":' .. json .. '}')
end

function T.sendRaw(tbl)
  if T.state ~= 'connected' then return false end
  local s = toJson(tbl)
  if not s then return false end
  return queueLine(s)
end

-- Events are kept while idle too (ring buffer, oldest dropped first) and
-- flushed once the relay wants data again.
function T.pushEvent(e)
  T.events[#T.events + 1] = e
  while #T.events > T.eventCap do
    table.remove(T.events, 1)
    T.droppedEvents = T.droppedEvents + 1
  end
end

local function flushEvents()
  if #T.events == 0 or not T.isAwake() then return end
  if T.sendRaw({ type = 'events', v = HOOK_PROTOCOL, events = T.events, dropped = T.droppedEvents }) then
    T.events = {}
    T.droppedEvents = 0
  end
end

local function closeSocket(reason)
  if T.tcp then pcall(function() T.tcp:close() end) end
  T.tcp, T.rx, T.tx, T.txBytes, T.awake = nil, '', {}, 0, false
  if T.state ~= 'idle' then info('disconnected from relay (' .. tostring(reason) .. ')') end
  T.state = 'idle'
  T.retryAt = now() + T.backoff
  T.backoff = math.min(T.backoff * 2, BACKOFF_MAX_S)
end

local function startConnect()
  local tcp = socket.tcp()
  tcp:settimeout(0)
  local ok, e = tcp:connect('127.0.0.1', T.port)
  if ok or e == 'timeout' or e == 'Operation already in progress' then
    T.tcp, T.state, T.connectAt = tcp, 'connecting', now()
  else
    pcall(function() tcp:close() end)
    T.retryAt = now() + T.backoff
    T.backoff = math.min(T.backoff * 2, BACKOFF_MAX_S)
  end
end

local function handleMessage(msg)
  if type(msg) ~= 'table' then return end
  if msg.type == 'config' then
    T.config = msg
    if type(msg.eventBufferSize) == 'number' and msg.eventBufferSize > 0 then
      T.eventCap = msg.eventBufferSize
    end
    for _, cb in ipairs(T.configCbs) do pcall(cb, msg) end
  elseif msg.type == 'demand' then
    local wasAwake = T.awake
    T.awake = (tonumber(msg.subscribers) or 0) > 0
    if T.awake ~= wasAwake then info(T.awake and 'relay has subscribers - collecting' or 'no subscribers - idle') end
  elseif msg.type == 'resync' then
    for _, cb in ipairs(T.resyncCbs) do pcall(cb) end
  end
end

local function pumpConnected()
  -- receive
  while true do
    local line, e, partial = T.tcp:receive('*l', T.rx)
    if line then
      T.rx = ''
      handleMessage(fromJson(line))
    elseif e == 'timeout' then
      T.rx = partial or T.rx
      break
    else
      closeSocket(e)
      return
    end
  end
  -- send
  while #T.tx > 0 do
    local chunk = T.tx[1]
    local last, e, partialLast = T.tcp:send(chunk)
    if last == #chunk then
      table.remove(T.tx, 1)
      T.txBytes = T.txBytes - #chunk
    else
      local sent = last or partialLast or 0
      if sent > 0 then
        T.tx[1] = chunk:sub(sent + 1)
        T.txBytes = T.txBytes - sent
      end
      if e and e ~= 'timeout' then closeSocket(e) end
      return
    end
  end
end

function T.tick()
  if T.state == 'idle' then
    if now() >= T.retryAt then startConnect() end
  elseif T.state == 'connecting' then
    local _, writable = socket.select(nil, { T.tcp }, 0)
    if writable and #writable > 0 and T.tcp:getpeername() then
      T.state, T.backoff = 'connected', BACKOFF_MIN_S
      info('connected to relay on 127.0.0.1:' .. T.port)
      if T.helloFn then T.sendRaw(T.helloFn()) end
    elseif now() - T.connectAt > CONNECT_TIMEOUT_S then
      closeSocket('connect timeout')
    end
  end
  if T.state == 'connected' then
    pumpConnected()
    flushEvents()
  end
end

function T.stop()
  if T.tcp then pcall(function() T.tcp:close() end) end
  T.tcp, T.state, T.rx, T.tx, T.txBytes, T.awake = nil, 'idle', '', {}, 0, false
  T.retryAt, T.backoff = 0, BACKOFF_MIN_S
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

-- Units are gathered a slice at a time across several hook ticks (one
-- S.unitsStep call per tick), so a big mission never costs one long frame.
-- Each unit is encoded in the same step it's gathered, and only units whose
-- rounded record changed since the last cycle are encoded at all; units gone
-- since then are sent as null. A full cycle (first one, or after a resync)
-- encodes every unit.
-- Records are keyed by unit id as a string (numeric keys would make the
-- encoder treat a sparse table as an array). heading is atan2 of the unit's
-- forward vector on the map grid, in radians; converting it to true north is
-- the consumer's job.

local function round(x, step) return math.floor(x / step + 0.5) * step end

local function unitRecord(u, ge)
  if not u:isExist() then return nil end
  local pos = u:getPosition()
  local p = pos.p
  local lat, lon, alt = coord.LOtoLL(p)
  local v = u:getVelocity()
  return tostring(u:getID()), {
    name = u:getName(), type = u:getTypeName(), coalition = ge.side,
    groupId = ge.gid, groupName = ge.gname, category = ge.gcat,
    lat = round(lat, 1e-6), lon = round(lon, 1e-6), alt = round(alt, 0.1),
    agl = round(alt - land.getHeight({ x = p.x, y = p.z }), 0.1),
    heading = round(math.atan2(pos.x.z, pos.x.x), 1e-3),
    vx = round(v.x, 0.01), vy = round(v.y, 0.01), vz = round(v.z, 0.01),
    inAir = u:inAir(), life = u:getLife(), life0 = u:getLife0(),
    player = u:getPlayerName(), callsign = u:getCallsign(),
  }
end

local function sameRecord(a, b)
  for k, v in pairs(a) do if b[k] ~= v then return false end end
  for k in pairs(b) do if a[k] == nil then return false end end
  return true
end

S.prevUnits = {}
S.lastUnitCount = 0

-- start: begin a new cycle (full = encode every unit), spread over `slices`
-- calls. Every call reports the heap size before and after it (KB). Returns
-- 'P|kbBefore|kbAfter' while the cycle is still running, then
-- '<F|D>|kbBefore|kbAfter|units|changed|removed|' followed by the JSON object.
function S.unitsStep(start, full, slices)
  local kb0 = heapKb()
  if start or not S.uc then
    local groups = {}
    for side = 0, 2 do
      for _, g in ipairs(coalition.getGroups(side) or {}) do
        groups[#groups + 1] = { g = g, side = side }
      end
    end
    S.uc = {
      groups = groups, gi = 1, ui = 1, full = full, out = {}, parts = {},
      n = 0, changed = 0,
      perStep = math.max(50, math.ceil(S.lastUnitCount / math.max(1, slices))),
    }
  end
  local uc = S.uc
  local done = 0
  while done < uc.perStep do
    local ge = uc.groups[uc.gi]
    if not ge then break end
    if not ge.units then
      local ok = pcall(function()
        if not ge.g:isExist() then return end
        ge.gid, ge.gname, ge.gcat = ge.g:getID(), ge.g:getName(), ge.g:getCategory()
        ge.units = ge.g:getUnits()
      end)
      if not ok or not ge.units then ge.units = {} end
    end
    local u = ge.units[uc.ui]
    if not u then
      uc.gi, uc.ui = uc.gi + 1, 1
    else
      uc.ui = uc.ui + 1
      done = done + 1
      local ok, id, rec = pcall(unitRecord, u, ge)
      if ok and id then
        uc.out[id] = rec
        uc.n = uc.n + 1
        local prev = S.prevUnits[id]
        if uc.full or not prev or not sameRecord(prev, rec) then
          uc.parts[#uc.parts + 1] = encode(id) .. ':' .. encode(rec)
          uc.changed = uc.changed + 1
        end
      end
    end
  end
  if uc.groups[uc.gi] then return 'P|' .. kb0 .. '|' .. heapKb() end

  local removed = 0
  if not uc.full then
    for id in pairs(S.prevUnits) do
      if not uc.out[id] then
        uc.parts[#uc.parts + 1] = encode(id) .. ':null'
        removed = removed + 1
      end
    end
  end
  S.prevUnits, S.lastUnitCount, S.uc = uc.out, uc.n, nil
  local json = '{' .. table.concat(uc.parts, ',') .. '}'
  return (uc.full and 'F' or 'D') .. '|' .. kb0 .. '|' .. heapKb() .. '|'
    .. uc.n .. '|' .. uc.changed .. '|' .. removed .. '|' .. json
end

S.collectors = {
  heartbeat = function()
    return { modelTime = timer.getTime(), absTime = timer.getAbsTime(), theatre = env.mission and env.mission.theatre }
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
  S.events[#S.events + 1] = rec
  while #S.events > S.eventCap do table.remove(S.events, 1) end
end
world.addEventHandler(S.eventHandler)

-- One incremental garbage-collection step of this Lua state, doing the work
-- Lua would do for `kb` KB of allocation. Called every hook tick while
-- collecting, so collection keeps pace in small steps instead of piling up
-- into one long pause. Returns '<1 if a cycle finished|0>|kbBefore|kbAfter'.
function S.gcStep(kb)
  local before = heapKb()
  local finished = collectgarbage('step', kb)
  return (finished and '1' or '0') .. '|' .. before .. '|' .. heapKb()
end

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
  side     = nil,       -- 'server' | 'client'
  registry = {},
  order    = {},
  seq      = 0,
}

-- side: 'server' | 'client' | 'both'. gather() returns JSON text or nil.
-- A sliced collector instead gets gather(start, full, slices) once per tick
-- until it returns its result: json, kind ('full'|'delta') and an optional
-- table of extra timing fields.
local function register(name, side, defaultRateS, gather, sliced)
  C.registry[name] = {
    name = name, side = side, rateS = defaultRateS, enabled = true, gather = gather,
    sliced = sliced == true, dueAt = 0, full = true, active = false,
  }
  C.order[#C.order + 1] = name
end

local function inServer(code)
  local ok, result = pcall(net.dostring_in, 'server', code)
  if ok then return result end
  return nil
end

-- Each step also returns the mission-side heap size (KB) before and after it,
-- as a third value, for the per-step diagnostics in runCollectors.
register('units', 'server', 1, function(start, full, slices)
  local r = inServer(string.format(
    'return TRACS_EXP_S and TRACS_EXP_S.unitsStep(%s, %s, %d) or "E"',
    tostring(start), tostring(full), slices))
  if r == nil or r == 'E' then error('units step failed (mission environment not bootstrapped?)') end
  local p0, p1 = r:match('^P|(%-?%d+)|(%-?%d+)$')
  if p0 then return nil, nil, nil, { tonumber(p0), tonumber(p1) } end
  local kind, k0, k1, n, changed, removed, json = r:match('^(%a)|(%-?%d+)|(%-?%d+)|(%d+)|(%d+)|(%d+)|(.*)$')
  if not kind then error('unexpected units step result') end
  return json, kind == 'F' and 'full' or 'delta', {
    units = tonumber(n), changed = tonumber(changed), removed = tonumber(removed),
  }, { tonumber(k0), tonumber(k1) }
end, true)

register('heartbeat', 'server', 5, function()
  return inServer('return TRACS_EXP_S and TRACS_EXP_S.collect("heartbeat") or "null"')
end)

register('heartbeat_client', 'client', 5, function()
  return toJson({ modelTime = DCS.getModelTime() })
end)

C.gcStepKb = DEFAULT_GC_STEP_KB
C.gc = { ms = 0, maxMs = 0, steps = 0, cycles = 0, kb = -1, reportAt = 0 }

-- Applies the relay's per-collector settings; collectors the relay doesn't
-- mention keep their defaults.
T.onConfig(function(cfg)
  if type(cfg.gcStepKb) == 'number' and cfg.gcStepKb >= 0 then C.gcStepKb = math.floor(cfg.gcStepKb) end
  if type(cfg.collectors) ~= 'table' then return end
  for name, c in pairs(C.registry) do
    local s = cfg.collectors[name]
    if type(s) == 'table' then
      if s.enabled ~= nil then c.enabled = s.enabled and true or false end
      if type(s.rateSec) == 'number' and s.rateSec > 0 then c.rateS = math.max(s.rateSec, MIN_RATE_S) end
    end
  end
end)

-- Collectors start one tick apart so ones with the same rate don't all land
-- in the same frame. A sliced cycle in progress is abandoned and restarts as
-- a full one.
T.onResync(function()
  local t = now()
  for i, name in ipairs(C.order) do
    local c = C.registry[name]
    c.dueAt, c.full, c.active = t + (i - 1) * TICK_INTERVAL_S, true, false
  end
end)

local function resetCollectors()
  C.seq = 0
  if C.gc then C.gc.reportAt = 0 end
  for _, c in pairs(C.registry) do c.dueAt, c.full, c.active = 0, true, false end
end

local function sideMatches(c) return c.side == 'both' or c.side == C.side end

local function sendResult(c, json, kind, ms, extra)
  C.seq = C.seq + 1
  T.send(c.name, kind, C.seq, json)
  local timing = { type = 'timing', group = c.name, kind = kind, ms = ms, bytes = #json }
  if type(extra) == 'table' then for k, v in pairs(extra) do timing[k] = v end end
  T.sendRaw(timing)
  c.full = false
end

-- Runs every collector that's due, and one step of every sliced collector
-- whose cycle is in progress. Timings go to the relay (logged with
-- exporter.logTimings): for a sliced collector, ms is the whole cycle and
-- maxStepMs the worst single frame, which is what a player feels.
local function runCollectors()
  local t = now()
  for _, name in ipairs(C.order) do
    local c = C.registry[name]
    if c.enabled and sideMatches(c) and (c.active or t >= c.dueAt) then
      if c.sliced then
        local start = not c.active
        if start then
          c.active, c.dueAt, c.cycleMs, c.maxStepMs, c.steps = true, t + c.rateS, 0, 0, 0
        end
        -- One step short of the period, so a cycle finishes before the next is due.
        local slices = math.max(1, math.floor(c.rateS / TICK_INTERVAL_S) - 1)
        local hook0 = math.floor(collectgarbage('count'))
        local t0 = now()
        local ok, json, kind, extra, heap = pcall(c.gather, start, c.full, slices)
        local ms = (now() - t0) * 1000
        local hook1 = math.floor(collectgarbage('count'))
        c.cycleMs, c.steps = c.cycleMs + ms, c.steps + 1
        -- Diagnostics for the worst step: which step it was and how both Lua
        -- heaps moved during it. A large drop means a garbage collection ran
        -- inside that step.
        if ms > c.maxStepMs then
          c.maxStepMs, c.maxStepIdx = ms, c.steps
          c.maxStepHookKbDelta = hook1 - hook0
          c.maxStepSrvKbDelta = (ok and type(heap) == 'table') and (heap[2] - heap[1]) or 0
          c.srvKb = (ok and type(heap) == 'table') and heap[2] or -1
          c.hookKb = hook1
        end
        if not ok then
          c.active = false
          err('collector ' .. name .. ' failed: ' .. tostring(json))
        elseif json then
          c.active = false
          extra = type(extra) == 'table' and extra or {}
          extra.maxStepMs, extra.steps, extra.maxStepIdx = c.maxStepMs, c.steps, c.maxStepIdx
          extra.maxStepSrvKbDelta, extra.maxStepHookKbDelta = c.maxStepSrvKbDelta, c.maxStepHookKbDelta
          extra.srvKb, extra.hookKb = c.srvKb, c.hookKb
          sendResult(c, json, kind, c.cycleMs, extra)
        end
      else
        c.dueAt = t + c.rateS
        local t0 = now()
        local ok, json = pcall(c.gather)
        local ms = (now() - t0) * 1000
        if ok and json then
          sendResult(c, json, 'full', ms)
        elseif not ok then
          err('collector ' .. name .. ' failed: ' .. tostring(json))
        end
      end
    end
  end
end

-- Runs one mission-side GC step per tick while collecting, and reports its
-- cost once a second as a 'gc' timing: total and worst step ms, steps, and
-- how many collection cycles finished.
local GC_REPORT_INTERVAL_S = 1
local function runGcStep()
  if C.side ~= 'server' or C.gcStepKb <= 0 then return end
  local g = C.gc
  local t0 = now()
  local r = inServer('return TRACS_EXP_S and TRACS_EXP_S.gcStep(' .. C.gcStepKb .. ') or "E"')
  local ms = (now() - t0) * 1000
  local done, _, after = (r or ''):match('^(%d)|(%-?%d+)|(%-?%d+)$')
  if not done then return end
  g.ms, g.steps = g.ms + ms, g.steps + 1
  if ms > g.maxMs then g.maxMs = ms end
  if done == '1' then g.cycles = g.cycles + 1 end
  g.kb = tonumber(after)
  local t = now()
  if t >= g.reportAt then
    if g.reportAt > 0 then
      T.sendRaw({ type = 'timing', group = 'gc', kind = 'server', ms = g.ms, maxStepMs = g.maxMs,
        steps = g.steps, cycles = g.cycles, srvKb = g.kb, stepKb = C.gcStepKb })
    end
    g.ms, g.maxMs, g.steps, g.cycles, g.reportAt = 0, 0, 0, 0, t + GC_REPORT_INTERVAL_S
  end
end

-- Moves events buffered in the mission environment into the transport's
-- buffer. Runs while idle too, so events from before the first subscriber
-- aren't lost.
local EVENT_DRAIN_INTERVAL_S = 1
local nextEventDrain = 0
local function drainServerEvents()
  if C.side ~= 'server' or now() < nextEventDrain then return end
  nextEventDrain = now() + EVENT_DRAIN_INTERVAL_S
  local events = inServer('return TRACS_EXP_S and TRACS_EXP_S.drainEvents() or "[]"')
  if events and events ~= '[]' then
    local list = fromJson(events)
    if type(list) == 'table' then for _, e in ipairs(list) do T.pushEvent(e) end end
  end
end

---------------------------------------------------------------------------
-- DCS callbacks
---------------------------------------------------------------------------

local lastTick = 0
local callbacks = {}

function callbacks.onMissionLoadEnd()
  local ok, e = pcall(function()
    C.side = DCS.isServer() and 'server' or 'client'
    resetCollectors()
    T.port = tonumber(loadLocalConfig().port) or DEFAULT_PORT
    if C.side == 'server' then
      local r = inServer(SERVER_BOOTSTRAP)
      if r ~= 'ok' then err('mission environment bootstrap failed: ' .. tostring(r)) end
    end
    T.helloFn = function()
      local mission = DCS.getCurrentMission()
      return {
        type = 'hello', v = HOOK_PROTOCOL, side = C.side,
        multiplayer = DCS.isMultiplayer(),
        theatre = mission and mission.mission and mission.mission.theatre,
        collectors = C.order,
      }
    end
    info('mission loaded - side=' .. C.side .. ', relay port ' .. T.port)
  end)
  if not ok then err('onMissionLoadEnd: ' .. tostring(e)) end
end

function callbacks.onSimulationFrame()
  if not C.side then return end
  local t = now()
  if t - lastTick < TICK_INTERVAL_S then return end
  lastTick = t
  local ok, e = pcall(function()
    T.tick()
    drainServerEvents()
    if T.isAwake() then
      runCollectors()
      runGcStep()
    end
  end)
  if not ok then err('onSimulationFrame: ' .. tostring(e)) end
end

function callbacks.onSimulationStop()
  pcall(T.stop)
  resetCollectors()
  C.side, nextEventDrain = nil, 0
  T.events, T.droppedEvents = {}, 0
end

DCS.setUserCallbacks(callbacks)
info('hook loaded')
