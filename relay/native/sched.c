/* See sched.h. Runs on the sim thread, from the hook state's
   onSimulationFrame. The relay decides when anything is gathered at all:
   collectors only run while it reports at least one subscriber ("demand"),
   so an idle exporter costs a few lock-protected checks per tick.

   Every collector DCS runs is written in C (sched.h's NativeGather),
   registered by name and called directly, with no Lua in between. Lua
   collectors (register) exist only for the harness test, which runs the
   scheduler outside DCS:
     plain:  gather() -> json [, once]
     sliced: gather(start, full, slices, sensorUnitsOnly) once per tick until
             it returns json, kind ('full'|'delta'), extra timing fields,
             {heapKbBefore, heapKbAfter} of the mission state, once.
   `once` means don't run again until the next resync.

   Events come from the mission's event handler (server.c) straight into a
   buffer here, which is kept while idle (oldest dropped past
   eventBufferSize) and sent once a second while collecting.

   The tick is finer than any data rate so a sliced collector's work spreads
   across ticks; no collector runs more often than once a second, the
   fastest rate anything in TRACS consumes. Timings and the frame-time log
   are only built and sent with the relay's exporter.logTimings. */

#define LUA_BUILD_AS_DLL
#include <windows.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include "lua.h"
#include "lauxlib.h"
#include "cJSON.h"
#include "common.h"
#include "net.h"
#include "sched.h"

#define TICK_INTERVAL_S        0.1
#define MIN_RATE_S             1.0
#define MAX_COLLECTORS         16
#define EVENT_FLUSH_INTERVAL_S 1.0
#define DEFAULT_EVENT_CAP      2000
#define MAX_EVENT_CAP          100000
#define FRAME_SLOW_MS          30.0
#define FULL_WARN_INTERVAL_S   10.0

enum { SIDE_NONE = -1, SIDE_SERVER, SIDE_CLIENT, SIDE_BOTH };

typedef struct {
  char name[32], group[32];
  int side, ref, enabled, sliced, sensorUnitsOnly;
  NativeGather native;
  double rateS, dueAt;
  int full, active;
  /* The cycle in progress, for the timing line. */
  double cycleMs, maxStepMs, maxStepHookKbDelta, maxStepSrvKbDelta, srvKb, hookKb;
  int steps, maxStepIdx;
} Collector;

static Collector g_col[MAX_COLLECTORS];
static int g_nCol;
static const NativeCollector *g_natives;

static struct {
  int side, ready;
  int connected, awake, logTimings;
  unsigned gen;
  double lastTick, lastFullWarn;
  unsigned long seq;
  JBuf hello;
  int multiplayer;
  char theatre[64];
  /* UTF-8 paths, "" when unknown. */
  char savedGames[3 * MAX_PATH];
  char missionFile[3 * MAX_PATH];
  double loadTimeMs;
  double nextEventFlush;
  char **events;
  int nEvents, eventCap, eventAlloc;
  long droppedEvents;
  double lastFrame, ourMs, sumMs, maxMs, ourSumMs, ourMaxMs, reportAt;
  int frames, slow;
  int sentinel;
} S = { .side = SIDE_NONE, .eventCap = DEFAULT_EVENT_CAP };

static int awake(void) { return S.connected && S.awake; }

static int sideOf(const char *s) {
  if (strcmp(s, "server") == 0) return SIDE_SERVER;
  if (strcmp(s, "client") == 0) return SIDE_CLIENT;
  return SIDE_BOTH;
}

static void copyName(char *dst, size_t n, const char *src) {
  strncpy_s(dst, n, src, _TRUNCATE);
}

static double heapKb(lua_State *L) { return (double)lua_gc(L, LUA_GCCOUNT, 0); }

/* ------------------------------------------------------------------ */
/* Sending                                                              */
/* ------------------------------------------------------------------ */

static int sendLine(lua_State *L, const JBuf *b) {
  if (!S.connected || b->oom || !b->len) return 0;
  int r = net_send(S.gen, b->p, b->len);
  if (r == -1) {
    double t = now_s();
    if (t - S.lastFullWarn > FULL_WARN_INTERVAL_S) {
      S.lastFullWarn = t;
      dcs_log(L, LOG_WARNING, "send buffer full - dropping messages (relay not keeping up?)");
    }
  }
  return r == 1;
}

static void sendHello(lua_State *L) { sendLine(L, &S.hello); }

static void buildHello(const char *status) {
  JBuf *b = &S.hello;
  jb_free(b);
  jb_printf(b, "{\"type\":\"hello\",\"v\":%d,\"side\":", HOOK_PROTOCOL);
  jb_str(b, S.side == SIDE_CLIENT ? "client" : "server");
  jb_puts(b, S.multiplayer ? ",\"multiplayer\":true" : ",\"multiplayer\":false");
  jb_puts(b, ",\"theatre\":");
  if (S.theatre[0]) jb_str(b, S.theatre); else jb_puts(b, "null");
  jb_puts(b, ",\"savedGames\":");
  if (S.savedGames[0]) jb_str(b, S.savedGames); else jb_puts(b, "null");
  jb_puts(b, ",\"missionFile\":");
  if (S.missionFile[0]) jb_str(b, S.missionFile); else jb_puts(b, "null");
  jb_puts(b, ",\"loadTimeMs\":");
  if (S.loadTimeMs > 0) jb_printf(b, "%.0f", S.loadTimeMs); else jb_puts(b, "null");
  jb_puts(b, ",\"collectors\":[");
  for (int i = 0; i < g_nCol; i++) {
    if (i) jb_puts(b, ",");
    jb_str(b, g_col[i].name);
  }
  jb_puts(b, "],\"dll\":");
  jb_puts(b, status && status[0] ? status : "null");
  jb_puts(b, "}");
}

/* Appends `,"key":value` for each number/boolean/string field of the Lua
   table at idx. */
static void appendFields(lua_State *L, int idx, JBuf *b) {
  if (!lua_istable(L, idx)) return;
  lua_pushnil(L);
  while (lua_next(L, idx)) {
    if (lua_type(L, -2) == LUA_TSTRING) {
      int t = lua_type(L, -1);
      if (t == LUA_TNUMBER || t == LUA_TBOOLEAN || t == LUA_TSTRING) {
        jb_puts(b, ",");
        jb_str(b, lua_tostring(L, -2));
        jb_puts(b, ":");
        if (t == LUA_TNUMBER) jb_num(b, lua_tonumber(L, -1));
        else if (t == LUA_TBOOLEAN) jb_puts(b, lua_toboolean(L, -1) ? "true" : "false");
        else jb_str(b, lua_tostring(L, -1));
      }
    }
    lua_pop(L, 1);
  }
}

static double modelTime(lua_State *L) {
  push_path(L, "DCS.getModelTime");
  double t = lua_pcall(L, 0, 1, 0) == 0 ? lua_tonumber(L, -1) : 0;
  lua_pop(L, 1);
  return t;
}

static void sendResult(lua_State *L, Collector *c, const char *json, size_t jlen, const char *kind, double ms,
                       int extraIdx, const JBuf *extraJson) {
  JBuf b;
  jb_init(&b);
  S.seq++;
  jb_printf(&b, "{\"type\":\"data\",\"v\":%d,\"group\":", HOOK_PROTOCOL);
  jb_str(&b, c->group);
  jb_puts(&b, ",\"kind\":");
  jb_str(&b, kind);
  jb_printf(&b, ",\"seq\":%lu,\"t\":%.3f,\"data\":", S.seq, modelTime(L));
  jb_put(&b, json, jlen);
  jb_puts(&b, "}");
  sendLine(L, &b);

  if (S.logTimings) {
    b.len = 0;
    jb_puts(&b, "{\"type\":\"timing\",\"group\":");
    jb_str(&b, c->group);
    jb_puts(&b, ",\"kind\":");
    jb_str(&b, kind);
    jb_puts(&b, ",\"ms\":");
    jb_num(&b, ms);
    jb_printf(&b, ",\"bytes\":%zu", jlen);
    if (c->sliced) {
      jb_puts(&b, ",\"maxStepMs\":"); jb_num(&b, c->maxStepMs);
      jb_printf(&b, ",\"steps\":%d,\"maxStepIdx\":%d", c->steps, c->maxStepIdx);
      jb_puts(&b, ",\"maxStepSrvKbDelta\":"); jb_num(&b, c->maxStepSrvKbDelta);
      jb_puts(&b, ",\"maxStepHookKbDelta\":"); jb_num(&b, c->maxStepHookKbDelta);
      jb_puts(&b, ",\"srvKb\":"); jb_num(&b, c->srvKb);
      jb_puts(&b, ",\"hookKb\":"); jb_num(&b, c->hookKb);
    }
    if (extraIdx) appendFields(L, extraIdx, &b);
    if (extraJson && extraJson->len && !extraJson->oom) jb_put(&b, extraJson->p, extraJson->len);
    jb_puts(&b, "}");
    sendLine(L, &b);
  }
  jb_free(&b);
  c->full = 0;
}

/* ------------------------------------------------------------------ */
/* Events                                                               */
/* ------------------------------------------------------------------ */

static void clearEvents(void) {
  for (int i = 0; i < S.nEvents; i++) free(S.events[i]);
  S.nEvents = 0;
  S.droppedEvents = 0;
}

/* Oldest dropped first once the buffer is full. */
static void pushEvent(char *json) {
  if (S.eventAlloc < S.eventCap) {
    char **grown = realloc(S.events, (size_t)S.eventCap * sizeof *S.events);
    if (!grown) { free(json); return; }
    S.events = grown;
    S.eventAlloc = S.eventCap;
  }
  while (S.nEvents >= S.eventCap) {
    free(S.events[0]);
    memmove(S.events, S.events + 1, (size_t)(S.nEvents - 1) * sizeof *S.events);
    S.nEvents--;
    S.droppedEvents++;
  }
  S.events[S.nEvents++] = json;
}

/* See sched.h. Only on a host that's ready: the event handler stays in
   DCS's list after a mission stops, until the next init replaces it. */
void sched_event(JBuf *b) {
  if (S.side != SIDE_SERVER || !S.ready || b->oom || !b->p) {
    jb_free(b);
    return;
  }
  pushEvent(b->p);
  jb_init(b);
}

static void flushEvents(lua_State *L) {
  if (!S.nEvents) return;
  JBuf b;
  jb_init(&b);
  jb_printf(&b, "{\"type\":\"events\",\"v\":%d,\"events\":[", HOOK_PROTOCOL);
  for (int i = 0; i < S.nEvents; i++) {
    if (i) jb_puts(&b, ",");
    jb_puts(&b, S.events[i]);
  }
  jb_printf(&b, "],\"dropped\":%ld}", S.droppedEvents);
  if (sendLine(L, &b)) clearEvents();
  jb_free(&b);
}

/* ------------------------------------------------------------------ */
/* Collectors                                                           */
/* ------------------------------------------------------------------ */

static void resetCollectors(void) {
  S.seq = 0;
  for (int i = 0; i < g_nCol; i++) {
    g_col[i].dueAt = 0;
    g_col[i].full = 1;
    g_col[i].active = 0;
  }
}

/* Collectors start one tick apart so ones with the same rate don't all land
   in the same frame. A sliced cycle in progress is abandoned and restarts as
   a full one. */
static void resync(void) {
  double t = now_s();
  for (int i = 0; i < g_nCol; i++) {
    g_col[i].dueAt = t + i * TICK_INTERVAL_S;
    g_col[i].full = 1;
    g_col[i].active = 0;
  }
}

static void runSliced(lua_State *L, Collector *c, double t) {
  int start = !c->active;
  if (start) {
    c->active = 1;
    c->dueAt = t + c->rateS;
    c->cycleMs = c->maxStepMs = 0;
    c->steps = 0;
  }
  /* One step short of the period, so a cycle finishes before the next is due. */
  int slices = (int)floor(c->rateS / TICK_INTERVAL_S) - 1;
  if (slices < 1) slices = 1;

  int top = lua_gettop(L);
  double hook0 = heapKb(L), t0 = now_s();
  lua_rawgeti(L, LUA_REGISTRYINDEX, c->ref);
  lua_pushboolean(L, start);
  lua_pushboolean(L, c->full);
  lua_pushnumber(L, slices);
  lua_pushboolean(L, c->sensorUnitsOnly);
  int ok = lua_pcall(L, 4, 5, 0) == 0;
  double ms = (now_s() - t0) * 1000, hook1 = heapKb(L);
  c->cycleMs += ms;
  c->steps++;
  /* Diagnostics for the worst step: which step it was and how both Lua
     heaps moved during it. A large drop means a garbage collection ran
     inside that step. */
  if (ms > c->maxStepMs) {
    c->maxStepMs = ms;
    c->maxStepIdx = c->steps;
    c->maxStepHookKbDelta = hook1 - hook0;
    c->maxStepSrvKbDelta = 0;
    c->srvKb = -1;
    if (ok && lua_istable(L, top + 4)) {
      lua_rawgeti(L, top + 4, 1);
      lua_rawgeti(L, top + 4, 2);
      c->maxStepSrvKbDelta = lua_tonumber(L, -1) - lua_tonumber(L, -2);
      c->srvKb = lua_tonumber(L, -1);
      lua_pop(L, 2);
    }
    c->hookKb = hook1;
  }
  if (!ok) {
    c->active = 0;
    dcs_log(L, LOG_ERROR, "collector %s failed: %s", c->name, lua_tostring(L, -1));
  } else if (lua_type(L, top + 1) == LUA_TSTRING) {
    size_t len;
    const char *json = lua_tolstring(L, top + 1, &len);
    const char *kind = lua_type(L, top + 2) == LUA_TSTRING ? lua_tostring(L, top + 2) : "full";
    c->active = 0;
    sendResult(L, c, json, len, kind, c->cycleMs, top + 3, NULL);
    if (lua_toboolean(L, top + 5)) c->dueAt = HUGE_VAL;
  }
  lua_settop(L, top);
}

static void runPlain(lua_State *L, Collector *c, double t) {
  c->dueAt = t + c->rateS;
  int top = lua_gettop(L);
  double t0 = now_s();
  lua_rawgeti(L, LUA_REGISTRYINDEX, c->ref);
  int ok = lua_pcall(L, 0, 2, 0) == 0;
  double ms = (now_s() - t0) * 1000;
  if (!ok) {
    dcs_log(L, LOG_ERROR, "collector %s failed: %s", c->name, lua_tostring(L, -1));
  } else if (lua_type(L, top + 1) == LUA_TSTRING) {
    size_t len;
    const char *json = lua_tolstring(L, top + 1, &len);
    sendResult(L, c, json, len, "full", ms, 0, NULL);
    if (lua_toboolean(L, top + 2)) c->dueAt = HUGE_VAL;
  }
  lua_settop(L, top);
}

/* A collector written in C. A sliced one keeps being called once per tick
   until its cycle ends, with the same worst-step diagnostics as a sliced Lua
   collector. */
static void runNative(lua_State *L, Collector *c, double t) {
  int start = !c->active;
  if (start) {
    c->dueAt = t + c->rateS;
    c->cycleMs = c->maxStepMs = 0;
    c->steps = 0;
    if (c->sliced) c->active = 1;
  }
  int slices = (int)floor(c->rateS / TICK_INTERVAL_S) - 1;
  if (slices < 1) slices = 1;

  JBuf out, extra;
  jb_init(&out);
  jb_init(&extra);
  NativeRun r = { start, c->full, slices, c->sensorUnitsOnly, &out, &extra, "full", 0, NULL, 0, -1, -1 };
  double hook0 = heapKb(L), t0 = now_s();
  int res = c->native(L, &r);
  double ms = (now_s() - t0) * 1000;
  c->cycleMs += ms;
  c->steps++;
  if (c->sliced && ms > c->maxStepMs) {
    c->maxStepMs = ms;
    c->maxStepIdx = c->steps;
    c->maxStepHookKbDelta = heapKb(L) - hook0;
    c->maxStepSrvKbDelta = r.srvKb0 >= 0 ? r.srvKb1 - r.srvKb0 : 0;
    c->srvKb = r.srvKb0 >= 0 ? r.srvKb1 : -1;
    c->hookKb = heapKb(L);
  }
  if (res == 2) goto done;
  c->active = 0;
  if (res < 0) {
    dcs_log(L, LOG_ERROR, "collector %s failed: %s", c->name, r.error ? r.error : "unknown error");
    /* Nothing more is collected; the hook side's frame() tells the relay. */
    if (r.fatal) S.ready = 0;
  } else if (res > 0 && !out.oom) {
    sendResult(L, c, out.p ? out.p : "{}", out.p ? out.len : 2, r.kind, c->cycleMs, 0, &extra);
    if (r.once) c->dueAt = HUGE_VAL;
  }
done:
  jb_free(&out);
  jb_free(&extra);
}

/* Every collector that's due, and one step of every sliced collector whose
   cycle is in progress. For a sliced collector the timing's ms is the whole
   cycle and maxStepMs the worst single frame, which is what a player feels. */
static void runCollectors(lua_State *L, double t) {
  for (int i = 0; i < g_nCol; i++) {
    Collector *c = &g_col[i];
    if (!c->enabled || !(c->side == SIDE_BOTH || c->side == S.side)) continue;
    if (!(c->active || t >= c->dueAt)) continue;
    if (c->native) runNative(L, c, t);
    else if (c->sliced) runSliced(L, c, t);
    else runPlain(L, c, t);
    if (!S.ready) return;
  }
}

/* ------------------------------------------------------------------ */
/* Messages from the relay                                              */
/* ------------------------------------------------------------------ */

static void applyConfig(cJSON *msg) {
  cJSON *v = cJSON_GetObjectItemCaseSensitive(msg, "eventBufferSize");
  if (cJSON_IsNumber(v) && v->valuedouble >= 1) {
    S.eventCap = v->valuedouble > MAX_EVENT_CAP ? MAX_EVENT_CAP : (int)v->valuedouble;
  }
  v = cJSON_GetObjectItemCaseSensitive(msg, "logTimings");
  S.logTimings = cJSON_IsTrue(v);
  cJSON *cols = cJSON_GetObjectItemCaseSensitive(msg, "collectors");
  if (!cJSON_IsObject(cols)) return;
  for (int i = 0; i < g_nCol; i++) {
    Collector *c = &g_col[i];
    cJSON *s = cJSON_GetObjectItemCaseSensitive(cols, c->name);
    if (!cJSON_IsObject(s)) continue;
    v = cJSON_GetObjectItemCaseSensitive(s, "enabled");
    if (cJSON_IsBool(v)) c->enabled = cJSON_IsTrue(v);
    v = cJSON_GetObjectItemCaseSensitive(s, "rateSec");
    if (cJSON_IsNumber(v) && v->valuedouble > 0) c->rateS = v->valuedouble < MIN_RATE_S ? MIN_RATE_S : v->valuedouble;
    v = cJSON_GetObjectItemCaseSensitive(s, "sensorUnitsOnly");
    if (cJSON_IsBool(v)) c->sensorUnitsOnly = cJSON_IsTrue(v);
  }
}

static void handleMessage(lua_State *L, const char *line) {
  cJSON *msg = cJSON_Parse(line);
  cJSON *type = cJSON_GetObjectItemCaseSensitive(msg, "type");
  if (cJSON_IsString(type)) {
    if (strcmp(type->valuestring, "config") == 0) {
      applyConfig(msg);
    } else if (strcmp(type->valuestring, "demand") == 0) {
      cJSON *n = cJSON_GetObjectItemCaseSensitive(msg, "subscribers");
      int was = S.awake;
      S.awake = cJSON_IsNumber(n) && n->valuedouble > 0;
      if (S.awake != was) dcs_log(L, LOG_INFO, S.awake ? "relay has subscribers - collecting" : "no subscribers - idle");
    } else if (strcmp(type->valuestring, "resync") == 0) {
      resync();
    }
  }
  cJSON_Delete(msg);
}

static void processNet(lua_State *L) {
  NetItem *items = net_poll();
  for (NetItem *it = items; it; it = it->next) {
    switch (it->kind) {
      case NET_LOG:
        dcs_log(L, it->level, "%s", it->data);
        break;
      case NET_CONNECTED:
        S.connected = 1;
        S.gen = it->gen;
        S.awake = 0;
        dcs_log(L, LOG_INFO, "connected to relay on 127.0.0.1:%s", it->data);
        sendHello(L);
        break;
      case NET_DISCONNECTED:
        if (S.connected && it->gen == S.gen) {
          S.connected = 0;
          S.gen = 0;
          S.awake = 0;
          dcs_log(L, LOG_INFO, "disconnected from relay (%s)", it->data);
        }
        break;
      case NET_LINE:
        if (S.connected && it->gen == S.gen) handleMessage(L, it->data);
        break;
    }
  }
  net_free(items);
}

/* ------------------------------------------------------------------ */
/* Frame-time log                                                       */
/* ------------------------------------------------------------------ */

/* The time between simulation frames (all of DCS's work, not only ours)
   and how much of each frame was this exporter's. Once a second a 'frames'
   timing (count, average and worst frame, our total and worst ms); right
   away a 'slow' one for any frame over FRAME_SLOW_MS, with our share of it,
   so a spike can be told apart as ours or not. */
static void trackFrame(lua_State *L, double t) {
  double frameMs = S.lastFrame > 0 ? (t - S.lastFrame) * 1000 : -1, our = S.ourMs;
  S.lastFrame = t;
  S.ourMs = 0;
  if (frameMs < 0 || !awake() || !S.logTimings) return;
  S.frames++;
  S.sumMs += frameMs;
  S.ourSumMs += our;
  if (frameMs > S.maxMs) S.maxMs = frameMs;
  if (our > S.ourMaxMs) S.ourMaxMs = our;
  JBuf b;
  jb_init(&b);
  if (frameMs > FRAME_SLOW_MS) {
    S.slow++;
    jb_puts(&b, "{\"type\":\"timing\",\"group\":\"frames\",\"kind\":\"slow\",\"ms\":");
    jb_num(&b, frameMs);
    jb_puts(&b, ",\"ourMs\":");
    jb_num(&b, our);
    jb_puts(&b, "}");
    sendLine(L, &b);
  }
  if (t >= S.reportAt) {
    if (S.reportAt > 0) {
      b.len = 0;
      jb_puts(&b, "{\"type\":\"timing\",\"group\":\"frames\",\"kind\":\"second\",\"ms\":");
      jb_num(&b, S.sumMs / S.frames);
      jb_printf(&b, ",\"frames\":%d,\"maxMs\":", S.frames);
      jb_num(&b, S.maxMs);
      jb_puts(&b, ",\"ourMs\":");
      jb_num(&b, S.ourSumMs);
      jb_puts(&b, ",\"ourMaxMs\":");
      jb_num(&b, S.ourMaxMs);
      jb_printf(&b, ",\"slow\":%d}", S.slow);
      sendLine(L, &b);
    }
    S.frames = S.slow = 0;
    S.sumMs = S.maxMs = S.ourSumMs = S.ourMaxMs = 0;
    S.reportAt = t + 1;
  }
  jb_free(&b);
}

/* ------------------------------------------------------------------ */
/* Lua-facing functions                                                 */
/* ------------------------------------------------------------------ */

/* The collector slot for name, emptied (an existing one is replaced). */
static Collector *slotFor(lua_State *L, const char *name, const char *side, double rate, const char *group) {
  Collector *c = NULL;
  for (int i = 0; i < g_nCol; i++) if (strcmp(g_col[i].name, name) == 0) c = &g_col[i];
  if (c) {
    if (!c->native) luaL_unref(L, LUA_REGISTRYINDEX, c->ref);
  } else {
    if (g_nCol == MAX_COLLECTORS) { luaL_error(L, "too many collectors"); return NULL; }
    c = &g_col[g_nCol++];
  }
  memset(c, 0, sizeof *c);
  copyName(c->name, sizeof c->name, name);
  copyName(c->group, sizeof c->group, group);
  c->side = sideOf(side);
  c->rateS = rate < MIN_RATE_S ? MIN_RATE_S : rate;
  c->enabled = 1;
  c->full = 1;
  c->ref = LUA_NOREF;
  return c;
}

/* register(name, side, rateS, sliced, gather [, group]): a Lua collector,
   for the harness test. */
static int l_register(lua_State *L) {
  const char *name = luaL_checkstring(L, 1);
  const char *side = luaL_checkstring(L, 2);
  double rate = luaL_checknumber(L, 3);
  int sliced = lua_toboolean(L, 4);
  luaL_checktype(L, 5, LUA_TFUNCTION);
  const char *group = luaL_optstring(L, 6, name);
  Collector *c = slotFor(L, name, side, rate, group);
  c->sliced = sliced;
  lua_pushvalue(L, 5);
  c->ref = luaL_ref(L, LUA_REGISTRYINDEX);
  return 0;
}

/* See sched.h. */
int sched_registerNative(lua_State *L, const char *name, const char *side, double rate, const char *group) {
  const NativeCollector *found = NULL;
  for (const NativeCollector *n = g_natives; n && n->name; n++) {
    if (strcmp(n->name, name) == 0) found = n;
  }
  if (!found) return 0;
  Collector *c = slotFor(L, name, side, rate, group ? group : name);
  c->native = found->gather;
  c->sliced = found->sliced;
  return 1;
}

/* registerNative(name, side, rateS [, group]), for the harness test. */
static int l_registerNative(lua_State *L) {
  const char *name = luaL_checkstring(L, 1);
  if (!sched_registerNative(L, name, luaL_checkstring(L, 2), luaL_checknumber(L, 3), luaL_optstring(L, 4, name))) {
    return luaL_error(L, "no native collector named %s", name);
  }
  return 0;
}

/* The hook state closing (DCS exiting) ends the network thread. */
static int l_sentinelGc(lua_State *L) {
  (void)L;
  net_shutdown();
  return 0;
}

static void installSentinel(lua_State *L) {
  if (S.sentinel) return;
  S.sentinel = 1;
  lua_newuserdata(L, 1);
  lua_createtable(L, 0, 1);
  lua_pushcfunction(L, l_sentinelGc);
  lua_setfield(L, -2, "__gc");
  lua_setmetatable(L, -2);
  lua_setfield(L, LUA_REGISTRYINDEX, "tracs_exporter.sentinel");
}

/* See sched.h. */
void sched_start(lua_State *L, int port, int server, int multiplayer, const char *theatre, const char *status,
                 int ready, const MissionInfo *info) {
  S.side = server ? SIDE_SERVER : SIDE_CLIENT;
  S.multiplayer = multiplayer;
  copyName(S.theatre, sizeof S.theatre, theatre ? theatre : "");
  copyName(S.savedGames, sizeof S.savedGames, info && info->savedGames ? info->savedGames : "");
  copyName(S.missionFile, sizeof S.missionFile, info && info->missionFile ? info->missionFile : "");
  S.loadTimeMs = info ? info->loadTimeMs : 0;
  S.ready = ready;
  buildHello(status);
  resetCollectors();
  S.lastTick = 0;
  S.nextEventFlush = 0;
  S.lastFrame = S.reportAt = 0;
  installSentinel(L);
  if (!net_connect(port)) dcs_log(L, LOG_ERROR, "could not start the network thread");
}

/* start{ port, side, multiplayer, theatre, status, ready }, for the harness
   test (in DCS, missionLoad calls sched_start). */
static int l_start(lua_State *L) {
  luaL_checktype(L, 1, LUA_TTABLE);
  lua_getfield(L, 1, "port");
  int port = (int)luaL_checknumber(L, -1);
  lua_getfield(L, 1, "side");
  int server = !(lua_isstring(L, -1) && strcmp(lua_tostring(L, -1), "client") == 0);
  lua_getfield(L, 1, "multiplayer");
  int multiplayer = lua_toboolean(L, -1);
  lua_getfield(L, 1, "theatre");
  const char *theatre = lua_isstring(L, -1) ? lua_tostring(L, -1) : NULL;
  lua_getfield(L, 1, "ready");
  int ready = lua_toboolean(L, -1);
  lua_getfield(L, 1, "status");
  sched_start(L, port, server, multiplayer, theatre, lua_isstring(L, -1) ? lua_tostring(L, -1) : NULL, ready, NULL);
  lua_settop(L, 1);
  return 0;
}

/* See sched.h. */
void sched_setStatus(lua_State *L, const char *status, int ready) {
  S.ready = ready;
  buildHello(status);
  sendHello(L);
}

/* See sched.h. */
void sched_frame(lua_State *L) {
  if (S.side == SIDE_NONE) return;
  double t = now_s();
  trackFrame(L, t);
  if (t - S.lastTick >= TICK_INTERVAL_S) {
    S.lastTick = t;
    processNet(L);
    if (S.ready && awake()) {
      if (t >= S.nextEventFlush) {
        S.nextEventFlush = t + EVENT_FLUSH_INTERVAL_S;
        flushEvents(L);
      }
      runCollectors(L, t);
    }
  }
  S.ourMs = (now_s() - t) * 1000;
}

void sched_stop(void) {
  net_disconnect();
  net_free(net_poll());
  S.side = SIDE_NONE;
  S.ready = 0;
  S.connected = S.awake = 0;
  S.gen = 0;
  clearEvents();
  resetCollectors();
}

static const luaL_Reg FUNCTIONS[] = {
  { "register", l_register },
  { "registerNative", l_registerNative },
  { "start", l_start },
  { NULL, NULL },
};

void sched_open(lua_State *L, const NativeCollector *natives) {
  g_natives = natives;
  luaL_register(L, NULL, FUNCTIONS);
}
