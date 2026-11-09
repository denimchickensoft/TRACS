/* TRACS exporter DLL - the native half of relay/dcs/Scripts/Hooks/TRACS-Exporter.lua.
 *
 * One file, loaded twice with require('tracs_exporter'): into the hook (GUI)
 * Lua state on every DCS instance, and on a host also into the mission
 * ('server') state, by code the hook injects with net.dostring_in. Windows
 * maps the DLL once per process, so both loaded copies share this file's C
 * globals; that's how the mission side hands data to the hook side without
 * passing it through either Lua state as a string (see post/take).
 *
 * Why it exists: the DCS functions we call build their results as Lua
 * tables, and in a shared Lua state that garbage ends up in a collection
 * that walks everything else living there (~95 MB), which shows as a frame
 * hitch. Called from here in a private state of our own (luaL_newstate), the
 * same C functions return identical results and their garbage costs a
 * fraction of a millisecond to collect. Each DCS function is taken with
 * lua_tocfunction, and unit/group/controller objects are rebuilt in the
 * private state as bare { id_ = ... } tables, which is all DCS reads.
 *
 * The hook itself is a thin shim: when a mission begins to load it calls
 * missionLoadBegin (noting the time), once it has loaded missionLoad,
 * which works out the side, initialises the DLL there (on a host, loading
 * it into the mission state too), registers the collectors and connects;
 * every frame it calls frame, and stop when the mission ends.
 *
 * Every private call runs inside an SEH guard: an access violation inside a
 * DCS function lands in our handler instead of ending the process. After one
 * the exporter stops calling DCS until the next mission load, and the
 * private state is left alone (it may be inconsistent).
 *
 * The DCS scripting API is sim-thread only; everything here runs on it,
 * except the connection to the relay (net.c), which has its own thread and
 * never touches Lua or DCS. Scheduling, events and timings: sched.c. */

#define LUA_BUILD_AS_DLL
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "lua.h"
#include "lauxlib.h"
#include "common.h"
#include "net.h"
#include "private.h"
#include "sched.h"
#include "client.h"
#include "server.h"

#define LOADED_MESSAGE_S 20
#define CLIENT_RETRY_S   1.0

static DcsFn SERVER_FNS[S_COUNT] = {
  { "Unit.getPoint" }, { "Unit.getPosition" }, { "Unit.getVelocity" }, { "Unit.getLife" },
  { "Unit.getPlayerName" }, { "Unit.inAir" }, { "Unit.getCoalition" }, { "Unit.getID" },
  { "Object.getCategory" }, { "Unit.getController" }, { "Controller.getDetectedTargets" },
  { "coalition.getGroups" }, { "Group.getUnits" }, { "land.getHeight" }, { "coord.LOtoLL" },
  /* Not Unit.getLife0: a Lua function in DCS (2.9.31), and its only use,
     a health percentage, isn't shown anywhere in TRACS. */
  { "Unit.isExist" }, { "Unit.isActive" }, { "Unit.getName", NULL, 1 }, { "Unit.getTypeName", NULL, 1 },
  { "Unit.getCallsign", NULL, 1 }, { "Unit.getGroup", NULL, 1 },
  { "Group.getID", NULL, 1 }, { "Group.getName", NULL, 1 }, { "Group.getCategory", NULL, 1 },
  { "Unit.hasSensors", NULL, 1 },
  /* The low-rate collectors (serverlow.c). Airbase methods returning a
     scalar or an object may be Lua (luaOk: they're read every 30 s at most);
     getPoint and getDesc return tables, so they must be C. The fog calls are
     newer than the rest (optional: fog then has no live values). */
  { "world.getAirbases" }, { "Airbase.isExist", NULL, 1 }, { "Airbase.getPoint" },
  { "Airbase.getCallsign", NULL, 1 }, { "Airbase.getCoalition", NULL, 1 }, { "Airbase.getUnit", NULL, 1 },
  { "Airbase.getDesc" }, { "coalition.getMainRefPoint" }, { "timer.getAbsTime" },
  { "atmosphere.getWind" }, { "atmosphere.getTemperatureAndPressure" },
  { "world.weather.getFogVisibilityDistance", NULL, 0, 0, 1 }, { "world.weather.getFogThickness", NULL, 0, 0, 1 },
};

static DcsFn CLIENT_FNS[C_COUNT] = {
  { "Export.LoGetWorldObjects" },
};

Side g_server = { SERVER_FNS, S_COUNT };
Side g_client = { CLIENT_FNS, C_COUNT };

/* Mission side -> hook side hand-off. Both run on the sim thread. */
static char *g_handoff;
static size_t g_handoffLen;

/* ------------------------------------------------------------------ */
/* Private state                                                        */
/* ------------------------------------------------------------------ */

static void resetSide(Side *s) {
  /* After a fault the private state may be inconsistent: leak it rather
     than let lua_close walk it. */
  if (s->P && !s->faulted) lua_close(s->P);
  s->P = NULL;
  s->ready = 0;
  s->faulted = 0;
  s->error[0] = 0;
}

static void setFault(Side *s, const char *fnPath, const char *context, unsigned long code) {
  s->faulted = 1;
  s->ready = 0;
  _snprintf_s(s->error, sizeof s->error, _TRUNCATE, "exception 0x%08lx in %s%s%s - exporter stopped for this mission",
              code, fnPath, context && context[0] ? " " : "", context ? context : "");
}

/* See private.h. */
int pcallGuarded(lua_State *L, Side *s, const char *what, int nargs, int nresults) {
  unsigned long code = 0;
  int r;
  __try {
    r = lua_pcall(L, nargs, nresults, 0) == 0 ? 0 : 1;
  } __except (code = GetExceptionCode(), EXCEPTION_EXECUTE_HANDLER) {
    setFault(s, what, NULL, code);
    return 2;
  }
  return r;
}

/* See private.h. */
int pcallShared(lua_State *L, Side *s, int f, int nargs, int nresults) {
  return pcallGuarded(L, s, s->fns[f].path, nargs, nresults);
}

/* See private.h. */
int pcallPrivate(Side *s, int f, int nargs, int nresults, const char *context) {
  unsigned long code = 0;
  int r;
  __try {
    r = lua_pcall(s->P, nargs, nresults, 0) == 0 ? 0 : 1;
  } __except (code = GetExceptionCode(), EXCEPTION_EXECUTE_HANDLER) {
    setFault(s, s->fns[f].path, context, code);
    return 2;
  }
  return r;
}

/* Looks up every function this side needs, and checks each is a plain C
   function (no upvalues), the only kind that can be moved to another state.
   One allowed to be Lua (luaOk) that is Lua, or a C function with upvalues,
   is marked isLua instead; an optional one that is missing is left NULL.
   Every function that fails is named. */
static int resolveFns(lua_State *L, Side *s) {
  s->error[0] = 0;
  for (int i = 0; i < s->nFns; i++) {
    DcsFn *f = &s->fns[i];
    push_path(L, f->path);
    f->fn = lua_tocfunction(L, -1);
    f->isLua = 0;
    const char *why = NULL;
    if (!f->fn) {
      if (lua_isnil(L, -1) && f->optional) { /* left out */ }
      else if (lua_isfunction(L, -1) && f->luaOk) f->isLua = 1;
      else why = lua_isnil(L, -1) ? "missing" : "not a C function";
    } else if (lua_getupvalue(L, -1, 1)) {
      lua_pop(L, 1);
      if (f->luaOk) f->isLua = 1; else why = "has upvalues";
    }
    lua_pop(L, 1);
    if (why) {
      char part[160];
      _snprintf_s(part, sizeof part, _TRUNCATE, "%s%s: %s", s->error[0] ? ", " : "", f->path, why);
      strncat_s(s->error, sizeof s->error, part, _TRUNCATE);
    }
  }
  return s->error[0] == 0;
}

static int openPrivate(Side *s) {
  s->P = luaL_newstate();
  if (!s->P) {
    _snprintf_s(s->error, sizeof s->error, _TRUNCATE, "luaL_newstate failed");
    return 0;
  }
  return 1;
}

void clearPrivate(Side *s) {
  lua_settop(s->P, 0);
  lua_gc(s->P, LUA_GCCOLLECT, 0);
}

/* ------------------------------------------------------------------ */
/* Self-test: each function called normally and privately must agree   */
/* ------------------------------------------------------------------ */

int readId(lua_State *L, int idx, Id *id) {
  lua_getfield(L, idx, "id_");
  id->type = lua_type(L, -1);
  id->num = id->type == LUA_TNUMBER ? lua_tonumber(L, -1) : 0;
  id->ptr = id->type == LUA_TLIGHTUSERDATA ? lua_touserdata(L, -1) : NULL;
  lua_pop(L, 1);
  return id->type == LUA_TNUMBER || id->type == LUA_TLIGHTUSERDATA;
}

void pushBare(lua_State *L, const Id *id) {
  lua_createtable(L, 0, 1);
  if (id->type == LUA_TLIGHTUSERDATA) lua_pushlightuserdata(L, id->ptr);
  else lua_pushnumber(L, id->num);
  lua_setfield(L, -2, "id_");
}

static lua_Number numField(lua_State *L, int idx, const char *k) {
  lua_getfield(L, idx, k);
  lua_Number v = lua_tonumber(L, -1);
  lua_pop(L, 1);
  return v;
}

/* Appends a short text form of the value at idx, enough to tell whether two
   calls returned the same thing: scalars as text, objects by id_, vectors
   and positions by their coordinates, lists by length. */
static void fingerprint(lua_State *L, int idx, char *out, size_t n) {
  char v[160];
  if (idx < 0) idx = lua_gettop(L) + idx + 1;
  int t = lua_type(L, idx);
  if (t == LUA_TNIL) _snprintf_s(v, sizeof v, _TRUNCATE, "nil");
  else if (t == LUA_TBOOLEAN) _snprintf_s(v, sizeof v, _TRUNCATE, "%s", lua_toboolean(L, idx) ? "true" : "false");
  else if (t == LUA_TNUMBER) _snprintf_s(v, sizeof v, _TRUNCATE, "%.6f", lua_tonumber(L, idx));
  else if (t == LUA_TSTRING) _snprintf_s(v, sizeof v, _TRUNCATE, "'%s'", lua_tostring(L, idx));
  else if (t == LUA_TTABLE) {
    Id id;
    lua_getfield(L, idx, "p");
    int isPosition = lua_istable(L, -1);
    lua_pop(L, 1);
    lua_getfield(L, idx, "x");
    int isVec = lua_type(L, -1) == LUA_TNUMBER;
    lua_pop(L, 1);
    lua_getfield(L, idx, "category");
    int isDesc = lua_type(L, -1) == LUA_TNUMBER;
    lua_pop(L, 1);
    if (readId(L, idx, &id)) {
      if (id.type == LUA_TNUMBER) _snprintf_s(v, sizeof v, _TRUNCATE, "id:%.0f", id.num);
      else _snprintf_s(v, sizeof v, _TRUNCATE, "id:%p", id.ptr);
    } else if (isPosition) {
      lua_getfield(L, idx, "p");
      lua_getfield(L, idx, "x");
      _snprintf_s(v, sizeof v, _TRUNCATE, "pos:%.3f,%.3f,%.3f/%.4f", numField(L, -2, "x"), numField(L, -2, "y"),
                  numField(L, -2, "z"), numField(L, -1, "x"));
      lua_pop(L, 2);
    } else if (isVec) {
      _snprintf_s(v, sizeof v, _TRUNCATE, "vec:%.3f,%.3f,%.3f", numField(L, idx, "x"), numField(L, idx, "y"),
                  numField(L, idx, "z"));
    } else if (isDesc) {
      lua_getfield(L, idx, "typeName");
      _snprintf_s(v, sizeof v, _TRUNCATE, "desc:%.0f/%s", numField(L, idx, "category"),
                  lua_isstring(L, -1) ? lua_tostring(L, -1) : "-");
      lua_pop(L, 1);
    } else {
      _snprintf_s(v, sizeof v, _TRUNCATE, "list:%d", (int)lua_objlen(L, idx));
    }
  } else _snprintf_s(v, sizeof v, _TRUNCATE, "type%d", t);
  strncat_s(out, n, v, _TRUNCATE);
  strncat_s(out, n, ";", _TRUNCATE);
}

/* Arguments a test call can take. Objects are passed as themselves in the
   calling state and as bare { id_ } tables in the private state. */
typedef enum { A_NONE, A_UNIT, A_CTRL, A_GROUP, A_AIRBASE, A_SIDE, A_VEC2, A_VEC3, A_METHOD } Arg;

typedef struct {
  int fn;
  Arg a1, a2;
  int nresults;
} Test;

static const Test SERVER_TESTS[] = {
  { S_GET_POINT, A_UNIT, A_NONE, 1 },     { S_GET_POSITION, A_UNIT, A_NONE, 1 },
  { S_GET_VELOCITY, A_UNIT, A_NONE, 1 },  { S_GET_LIFE, A_UNIT, A_NONE, 1 },
  { S_GET_PLAYER_NAME, A_UNIT, A_NONE, 1 }, { S_IN_AIR, A_UNIT, A_NONE, 1 },
  { S_GET_COALITION, A_UNIT, A_NONE, 1 }, { S_GET_ID, A_UNIT, A_NONE, 1 },
  { S_GET_CATEGORY, A_UNIT, A_NONE, 1 },  { S_GET_CONTROLLER, A_UNIT, A_NONE, 1 },
  { S_GET_DETECTED_TARGETS, A_CTRL, A_METHOD, 1 },
  { S_GET_GROUPS, A_SIDE, A_NONE, 1 },    { S_GET_UNITS, A_GROUP, A_NONE, 1 },
  { S_GET_HEIGHT, A_VEC2, A_NONE, 1 },    { S_LO_TO_LL, A_VEC3, A_NONE, 3 },
  { S_IS_EXIST, A_UNIT, A_NONE, 1 },      { S_IS_ACTIVE, A_UNIT, A_NONE, 1 },
  { S_GET_NAME, A_UNIT, A_NONE, 1 },      { S_GET_TYPE_NAME, A_UNIT, A_NONE, 1 },
  { S_GET_CALLSIGN, A_UNIT, A_NONE, 1 },
  { S_GET_GROUP, A_UNIT, A_NONE, 1 },     { S_GROUP_GET_ID, A_GROUP, A_NONE, 1 },
  { S_GROUP_GET_NAME, A_GROUP, A_NONE, 1 }, { S_GROUP_GET_CATEGORY, A_GROUP, A_NONE, 1 },
  { S_HAS_SENSORS, A_UNIT, A_NONE, 1 },
  { S_GET_AIRBASES, A_NONE, A_NONE, 1 },  { S_AB_IS_EXIST, A_AIRBASE, A_NONE, 1 },
  { S_AB_GET_POINT, A_AIRBASE, A_NONE, 1 }, { S_AB_GET_CALLSIGN, A_AIRBASE, A_NONE, 1 },
  { S_AB_GET_COALITION, A_AIRBASE, A_NONE, 1 }, { S_AB_GET_UNIT, A_AIRBASE, A_NONE, 1 },
  { S_AB_GET_DESC, A_AIRBASE, A_NONE, 1 }, { S_GET_MAIN_REF_POINT, A_SIDE, A_NONE, 1 },
  { S_GET_ABS_TIME, A_NONE, A_NONE, 1 },  { S_GET_WIND, A_VEC3, A_NONE, 1 },
  { S_GET_TEMP_PRESSURE, A_VEC3, A_NONE, 2 },
  { S_FOG_VISIBILITY, A_NONE, A_NONE, 1 }, { S_FOG_THICKNESS, A_NONE, A_NONE, 1 },
};

/* What the server self-test works on, found in the mission state. */
typedef struct {
  int haveUnit, haveCtrl, haveAirbase;
  int unitIdx, groupIdx, ctrlIdx, airbaseIdx;  /* stack slots in the mission state */
  Id unit, group, ctrl, airbase;
  lua_Number side, method;
  lua_Number x, y, z;              /* the unit's point, or the map origin */
  char context[128];               /* "(unit 123 F-16C_50)" for reports */
} Subject;

static void pushArg(lua_State *L, int isPrivate, Arg a, const Subject *sub) {
  switch (a) {
    case A_UNIT:  if (isPrivate) pushBare(L, &sub->unit); else lua_pushvalue(L, sub->unitIdx); break;
    case A_GROUP: if (isPrivate) pushBare(L, &sub->group); else lua_pushvalue(L, sub->groupIdx); break;
    case A_CTRL:  if (isPrivate) pushBare(L, &sub->ctrl); else lua_pushvalue(L, sub->ctrlIdx); break;
    case A_AIRBASE: if (isPrivate) pushBare(L, &sub->airbase); else lua_pushvalue(L, sub->airbaseIdx); break;
    case A_SIDE:  lua_pushnumber(L, sub->side); break;
    case A_METHOD: lua_pushnumber(L, sub->method); break;
    case A_VEC2:
      lua_createtable(L, 0, 2);
      lua_pushnumber(L, sub->x); lua_setfield(L, -2, "x");
      lua_pushnumber(L, sub->z); lua_setfield(L, -2, "y");
      break;
    case A_VEC3:
      lua_createtable(L, 0, 3);
      lua_pushnumber(L, sub->x); lua_setfield(L, -2, "x");
      lua_pushnumber(L, sub->y); lua_setfield(L, -2, "y");
      lua_pushnumber(L, sub->z); lua_setfield(L, -2, "z");
      break;
    default: break;
  }
}

static int needsUnit(const Test *t) {
  return t->a1 == A_UNIT || t->a1 == A_GROUP || t->a1 == A_CTRL || t->a2 == A_CTRL;
}

/* Whether a test can't run here: its function is an optional one this DCS
   lacks, or it needs a unit, controller or airbase the mission doesn't
   have. */
static int cantRun(const Side *s, const Test *t, const Subject *sub) {
  if (!s->fns[t->fn].fn && !s->fns[t->fn].isLua) return 1;
  if (needsUnit(t) && !sub->haveUnit) return 1;
  if ((t->a1 == A_CTRL || t->a2 == A_CTRL) && !sub->haveCtrl) return 1;
  return t->a1 == A_AIRBASE && !sub->haveAirbase;
}

/* One test: the call in L (normal) and in P (private), compared. Returns 1
   pass, 0 fail (reason in s->error), -1 fault. */
static int runTest(lua_State *L, Side *s, const Test *t, const Subject *sub) {
  char a[512] = "", b[512] = "";
  int nargs = (t->a1 != A_NONE) + (t->a2 != A_NONE);

  int top = lua_gettop(L);
  push_path(L, s->fns[t->fn].path);
  if (t->a1 != A_NONE) pushArg(L, 0, t->a1, sub);
  if (t->a2 != A_NONE) pushArg(L, 0, t->a2, sub);
  if (lua_pcall(L, nargs, t->nresults, 0) != 0) {
    _snprintf_s(a, sizeof a, _TRUNCATE, "error '%s'", lua_tostring(L, -1));
  } else {
    for (int i = t->nresults; i >= 1; i--) fingerprint(L, -i, a, sizeof a);
  }
  lua_settop(L, top);

  if (s->fns[t->fn].isLua) {
    /* Called the way the collectors call it: in this state, on a rebuilt
       object with its class's methods. */
    push_path(L, s->fns[t->fn].path);
    int cls = t->a1 == A_GROUP ? OBJ_GROUP : t->a1 == A_AIRBASE ? OBJ_AIRBASE : OBJ_UNIT;
    const Id *obj = cls == OBJ_GROUP ? &sub->group : cls == OBJ_AIRBASE ? &sub->airbase : &sub->unit;
    server_pushObject(L, obj, cls);
    int r = pcallShared(L, s, t->fn, 1, t->nresults);
    if (r == 2) return -1;
    if (r == 1) _snprintf_s(b, sizeof b, _TRUNCATE, "error '%s'", lua_tostring(L, -1));
    else for (int i = t->nresults; i >= 1; i--) fingerprint(L, -i, b, sizeof b);
    lua_settop(L, top);
  } else {
    lua_pushcfunction(s->P, s->fns[t->fn].fn);
    if (t->a1 != A_NONE) pushArg(s->P, 1, t->a1, sub);
    if (t->a2 != A_NONE) pushArg(s->P, 1, t->a2, sub);
    int r = pcallPrivate(s, t->fn, nargs, t->nresults, sub->context);
    if (r == 2) return -1;
    if (r == 1) _snprintf_s(b, sizeof b, _TRUNCATE, "error '%s'", lua_tostring(s->P, -1));
    else for (int i = t->nresults; i >= 1; i--) fingerprint(s->P, -i, b, sizeof b);
    clearPrivate(s);
  }

  if (strcmp(a, b) == 0) return 1;
  _snprintf_s(s->error, sizeof s->error, _TRUNCATE, "self-test: %s differs in a private state%s%s (normal %s, private %s)",
              s->fns[t->fn].path, sub->context[0] ? " " : "", sub->context, a, b);
  return 0;
}

/* Finds an active unit to test with, leaving the unit, its group and its
   controller on L's stack. A mission with no units yet still tests the
   functions that don't need one. */
static void findSubject(lua_State *L, Subject *sub) {
  memset(sub, 0, sizeof *sub);
  sub->side = 2;
  for (int side = 2; side >= 1 && !sub->haveUnit; side--) {
    push_path(L, "coalition.getGroups");
    lua_pushnumber(L, side);
    if (lua_pcall(L, 1, 1, 0) != 0 || !lua_istable(L, -1)) { lua_pop(L, 1); continue; }
    int groups = lua_gettop(L);
    int ng = (int)lua_objlen(L, groups);
    for (int g = 1; g <= ng && !sub->haveUnit; g++) {
      lua_rawgeti(L, groups, g);
      int group = lua_gettop(L);
      push_path(L, "Group.getUnits");
      lua_pushvalue(L, group);
      if (lua_pcall(L, 1, 1, 0) == 0 && lua_istable(L, -1)) {
        int units = lua_gettop(L);
        int nu = (int)lua_objlen(L, units);
        for (int u = 1; u <= nu; u++) {
          lua_rawgeti(L, units, u);
          int unit = lua_gettop(L);
          push_path(L, "Unit.isActive");
          lua_pushvalue(L, unit);
          int active = lua_pcall(L, 1, 1, 0) == 0 && lua_toboolean(L, -1);
          lua_pop(L, 1);
          if (active && readId(L, unit, &sub->unit) && readId(L, group, &sub->group)) {
            /* Keep group then unit on the stack, below everything else. */
            lua_pushvalue(L, group);
            lua_pushvalue(L, unit);
            lua_replace(L, groups);          /* groups slot <- unit */
            lua_replace(L, groups + 1);      /* group slot  <- group */
            lua_settop(L, groups + 1);
            sub->unitIdx = groups;
            sub->groupIdx = groups + 1;
            sub->haveUnit = 1;
            sub->side = side;
            break;
          }
          lua_settop(L, unit - 1);
        }
      }
      if (!sub->haveUnit) lua_settop(L, group - 1);
    }
    if (!sub->haveUnit) lua_settop(L, groups - 1);
  }
  if (!sub->haveUnit) return;

  push_path(L, "Unit.getPoint");
  lua_pushvalue(L, sub->unitIdx);
  if (lua_pcall(L, 1, 1, 0) == 0 && lua_istable(L, -1)) {
    sub->x = numField(L, -1, "x"); sub->y = numField(L, -1, "y"); sub->z = numField(L, -1, "z");
  }
  lua_pop(L, 1);

  const char *typeName = "?";
  push_path(L, "Unit.getTypeName");
  lua_pushvalue(L, sub->unitIdx);
  if (lua_pcall(L, 1, 1, 0) == 0 && lua_isstring(L, -1)) typeName = lua_tostring(L, -1);
  _snprintf_s(sub->context, sizeof sub->context, _TRUNCATE, "(unit %.0f %s)",
              sub->unit.type == LUA_TNUMBER ? sub->unit.num : 0.0, typeName);
  lua_pop(L, 1);

  push_path(L, "Unit.getController");
  lua_pushvalue(L, sub->unitIdx);
  if (lua_pcall(L, 1, 1, 0) == 0 && lua_istable(L, -1) && readId(L, -1, &sub->ctrl)) {
    sub->ctrlIdx = lua_gettop(L);
    sub->haveCtrl = 1;
  } else lua_pop(L, 1);

  push_path(L, "Controller.Detection");
  sub->method = lua_istable(L, -1) ? numField(L, -1, "RADAR") : 0;
  lua_pop(L, 1);
}

/* The mission's first airbase, for the Airbase tests, left on L's stack.
   Works without units, so it runs after findSubject whatever it found. */
static void findAirbase(lua_State *L, Subject *sub) {
  push_path(L, "world.getAirbases");
  if (lua_pcall(L, 0, 1, 0) != 0 || !lua_istable(L, -1)) { lua_pop(L, 1); return; }
  lua_rawgeti(L, -1, 1);
  if (lua_istable(L, -1) && readId(L, -1, &sub->airbase)) {
    lua_replace(L, -2);
    sub->airbaseIdx = lua_gettop(L);
    sub->haveAirbase = 1;
  } else {
    lua_pop(L, 2);
  }
}

/* ------------------------------------------------------------------ */
/* Lua-facing functions                                                 */
/* ------------------------------------------------------------------ */

static int failInit(lua_State *L, Side *s) {
  s->ready = 0;
  lua_pushnil(L);
  lua_pushstring(L, s->error);
  return 2;
}

static void outText(lua_State *L, const char *text) {
  push_path(L, "trigger.action");
  if (lua_istable(L, -1)) {
    lua_getfield(L, -1, "outText");
    lua_pushstring(L, text);
    lua_pushnumber(L, LOADED_MESSAGE_S);
    if (lua_pcall(L, 2, 0, 0) != 0) lua_pop(L, 1);
  }
  lua_pop(L, 1);
}

static void post(const char *s, size_t len) {
  free(g_handoff);
  g_handoff = malloc(len + 1);
  if (!g_handoff) { g_handoffLen = 0; return; }
  memcpy(g_handoff, s, len);
  g_handoff[len] = 0;
  g_handoffLen = len;
}

/* initServer() in the mission state, once per mission (missionLoad runs it
   with net.dostring_in). Returns true, or nil and the reason. Also installs
   the mission's event handler. The self-test summary is handed to the hook
   side through the shared hand-off rather than returned, which also proves
   the two loaded copies share memory. */
static int l_initServer(lua_State *L) {
  Side *s = &g_server;
  char msg[640];
  resetSide(s);
  server_removeEventHandler(L);
  server_reset(L);
  if (!resolveFns(L, s) || !openPrivate(s)) goto failed;
  for (int i = 0; i < s->nFns; i++) {
    if (s->fns[i].isLua) dcs_log(L, LOG_INFO, "%s is a Lua function in this DCS - called in the mission environment", s->fns[i].path);
    else if (!s->fns[i].fn) dcs_log(L, LOG_INFO, "%s is missing in this DCS - its value isn't sent", s->fns[i].path);
  }

  Subject sub;
  int top = lua_gettop(L);
  findSubject(L, &sub);
  findAirbase(L, &sub);
  int passed = 0, skipped = 0, nTests = (int)(sizeof SERVER_TESTS / sizeof SERVER_TESTS[0]);
  for (int i = 0; i < nTests; i++) {
    const Test *t = &SERVER_TESTS[i];
    if (cantRun(s, t, &sub)) {
      skipped++;
      continue;
    }
    int r = runTest(L, s, t, &sub);
    if (r <= 0) { lua_settop(L, top); goto failed; }
    passed++;
  }
  lua_settop(L, top);

  s->ready = 1;
  if (!server_installEventHandler(L, msg, sizeof msg)) {
    dcs_log(L, LOG_ERROR, "event handler not installed: %s - births are found by the 30-cycle re-list only", msg);
  }
  JBuf st;
  jb_init(&st);
  jb_printf(&st, "{\"passed\":%d,\"skipped\":%d,\"subject\":", passed, skipped);
  jb_str(&st, sub.haveUnit ? sub.context : "no active unit");
  jb_puts(&st, "}");
  if (!st.oom) post(st.p, st.len);
  jb_free(&st);
  outText(L, "TRACS Relay v" TRACS_VERSION " exporter loaded.");
  lua_pushboolean(L, 1);
  return 1;

failed:
  _snprintf_s(msg, sizeof msg, _TRUNCATE, "TRACS Relay v" TRACS_VERSION " exporter failed to load: %s", s->error);
  outText(L, msg);
  return failInit(L, s);
}

/* LoGetWorldObjects reduced to its object count and the sum of its keys.
   Returns the count. */
static int worldFingerprint(lua_State *L, int idx, char *out, size_t n) {
  int count = 0;
  lua_Number keys = 0;
  if (idx < 0) idx = lua_gettop(L) + idx + 1;
  if (lua_istable(L, idx)) {
    lua_pushnil(L);
    while (lua_next(L, idx)) {
      count++;
      if (lua_type(L, -2) == LUA_TNUMBER) keys += lua_tonumber(L, -2);
      lua_pop(L, 1);
    }
  }
  _snprintf_s(out, n, _TRUNCATE, "%d objects, key sum %.0f", count, keys);
  return count;
}

/* ------------------------------------------------------------------ */
/* Mission load, from the hook                                          */
/* ------------------------------------------------------------------ */

/* This mission's DLL status, sent to the relay in hello. A client's world
   is usually still empty at mission load (the server hasn't sent its units
   yet), which tests nothing: its self-test is then pending, repeated every
   CLIENT_RETRY_S until there are objects to compare, and nothing is
   collected meanwhile. */
static struct {
  int loaded, server, ok, pending;
  char error[700];
  JBuf selfTest;      /* the summary object, JSON */
  double retryAt;
} g_mission;

static void setError(const char *e) {
  g_mission.ok = 0;
  g_mission.pending = 0;
  _snprintf_s(g_mission.error, sizeof g_mission.error, _TRUNCATE, "%s", e && e[0] ? e : "unknown error");
}

/* The client's init in the hook state: LoGetWorldObjects called normally
   and privately must agree. */
static void initClient(lua_State *L) {
  Side *s = &g_client;
  char a[128], b[128];
  g_mission.selfTest.len = 0;
  resetSide(s);
  client_reset();
  if (!resolveFns(L, s) || !openPrivate(s)) { setError(s->error); return; }

  push_path(L, s->fns[C_GET_WORLD_OBJECTS].path);
  if (lua_pcall(L, 0, 1, 0) != 0) _snprintf_s(a, sizeof a, _TRUNCATE, "error '%s'", lua_tostring(L, -1));
  else worldFingerprint(L, -1, a, sizeof a);
  lua_pop(L, 1);

  lua_pushcfunction(s->P, s->fns[C_GET_WORLD_OBJECTS].fn);
  int r = pcallPrivate(s, C_GET_WORLD_OBJECTS, 0, 1, NULL);
  if (r == 2) { s->ready = 0; setError(s->error); return; }
  if (r == 1) _snprintf_s(b, sizeof b, _TRUNCATE, "error '%s'", lua_tostring(s->P, -1));
  int count = r == 1 ? 0 : worldFingerprint(s->P, -1, b, sizeof b);
  clearPrivate(s);

  if (strcmp(a, b) != 0) {
    _snprintf_s(s->error, sizeof s->error, _TRUNCATE, "self-test: %s differs in a private state (normal %s, private %s)",
                s->fns[C_GET_WORLD_OBJECTS].path, a, b);
    s->ready = 0;
    setError(s->error);
    return;
  }
  s->ready = count > 0;
  g_mission.ok = 1;
  g_mission.pending = count == 0;
  jb_printf(&g_mission.selfTest, "{\"passed\":%d,\"skipped\":0,\"pending\":%s,\"subject\":", count > 0 ? 1 : 0,
            count > 0 ? "false" : "true");
  jb_str(&g_mission.selfTest, a);
  jb_puts(&g_mission.selfTest, "}");
}

/* Lua's quoted-string form of s, for code sent with net.dostring_in. */
static void luaQuote(JBuf *b, const char *s) {
  jb_puts(b, "\"");
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '\\' || c == '"') { char e[2] = { '\\', (char)c }; jb_put(b, e, 2); }
    else if (c < 32) jb_printf(b, "\\%03u", c);
    else jb_put(b, (const char *)&c, 1);
  }
  jb_puts(b, "\"");
}

/* Loads the DLL into the mission state (the 'server' environment still has
   require) and runs initServer there, which also shows the loaded/failed
   message on screen. Returns 'ok' or 'ERR <reason>'. */
static const char *SERVER_INIT_HEAD = "local dir = ";
static const char *SERVER_INIT_BODY =
  "\n"
  "if not TRACS_DLL then\n"
  "  if not package then return 'ERR no package library in the mission environment' end\n"
  "  package.cpath = package.cpath .. ';' .. dir .. '?.dll'\n"
  "  local ok, m = pcall(require, 'tracs_exporter')\n"
  "  if not ok or type(m) ~= 'table' then\n"
  "    local msg = 'failed to load tracs_exporter.dll in the mission environment: ' .. tostring(m)\n"
  "    pcall(trigger.action.outText, 'TRACS Relay exporter ' .. msg, 20)\n"
  "    return 'ERR ' .. msg\n"
  "  end\n"
  "  TRACS_DLL = m\n"
  "end\n"
  "local ok, e = TRACS_DLL.initServer()\n"
  "if ok then return 'ok' end\n"
  "return 'ERR ' .. tostring(e)\n";

/* The host's init, run in the mission state. Its self-test summary comes
   back through the hand-off, not through dostring_in. */
static void initServer(lua_State *L, const char *dllDir) {
  g_mission.selfTest.len = 0;
  free(g_handoff);
  g_handoff = NULL;
  g_handoffLen = 0;

  JBuf code;
  jb_init(&code);
  jb_puts(&code, SERVER_INIT_HEAD);
  luaQuote(&code, dllDir);
  jb_puts(&code, SERVER_INIT_BODY);
  int top = lua_gettop(L);
  push_path(L, "net.dostring_in");
  lua_pushstring(L, "server");
  lua_pushlstring(L, code.oom ? "" : code.p, code.oom ? 0 : code.len);
  jb_free(&code);
  const char *r = lua_pcall(L, 2, 1, 0) == 0 && lua_isstring(L, -1) ? lua_tostring(L, -1) : NULL;
  if (!r || strcmp(r, "ok") != 0) {
    setError(!r ? "mission environment unreachable" : strncmp(r, "ERR ", 4) == 0 ? r + 4 : r);
  } else if (!g_handoff) {
    setError("no hand-off from the mission side - the two loaded copies of tracs_exporter.dll do not share memory");
  } else {
    g_mission.ok = 1;
    g_mission.pending = 0;
    jb_put(&g_mission.selfTest, g_handoff, g_handoffLen);
  }
  lua_settop(L, top);
  free(g_handoff);
  g_handoff = NULL;
  g_handoffLen = 0;
}

static int ready(void) { return g_mission.ok && !g_mission.pending; }

/* { ok, version, error?, selfTest?, pending } */
static void statusJson(JBuf *b) {
  jb_puts(b, g_mission.ok ? "{\"ok\":true" : "{\"ok\":false");
  jb_puts(b, ",\"version\":");
  jb_str(b, TRACS_VERSION);
  if (!g_mission.ok) {
    jb_puts(b, ",\"error\":");
    jb_str(b, g_mission.error);
  }
  if (g_mission.ok && g_mission.selfTest.len && !g_mission.selfTest.oom) {
    jb_puts(b, ",\"selfTest\":");
    jb_put(b, g_mission.selfTest.p, g_mission.selfTest.len);
  }
  jb_puts(b, g_mission.pending ? ",\"pending\":true}" : ",\"pending\":false}");
}

static void logStatus(lua_State *L) {
  if (g_mission.ok && g_mission.pending) {
    dcs_log(L, LOG_INFO, "tracs_exporter.dll v%s loaded - self-test waits for world objects", TRACS_VERSION);
  } else if (g_mission.ok) {
    dcs_log(L, LOG_INFO, "tracs_exporter.dll v%s ready - self-test %s", TRACS_VERSION,
            g_mission.selfTest.p ? g_mission.selfTest.p : "{}");
  } else {
    dcs_log(L, LOG_ERROR, "exporter not collecting: %s", g_mission.error);
  }
}

/* A DCS.* function returning a boolean, false if it fails. */
static int dcsBool(lua_State *L, const char *path) {
  push_path(L, path);
  int v = lua_pcall(L, 0, 1, 0) == 0 && lua_toboolean(L, -1);
  lua_pop(L, 1);
  return v;
}

/* The mission's theatre, into out ("" if unknown). */
static void missionTheatre(lua_State *L, char *out, size_t n) {
  out[0] = 0;
  int top = lua_gettop(L);
  push_path(L, "DCS.getCurrentMission");
  if (lua_pcall(L, 0, 1, 0) == 0 && lua_istable(L, -1)) {
    lua_getfield(L, -1, "mission");
    if (lua_istable(L, -1)) {
      lua_getfield(L, -1, "theatre");
      if (lua_isstring(L, -1)) _snprintf_s(out, n, _TRUNCATE, "%s", lua_tostring(L, -1));
    }
  }
  lua_settop(L, top);
}

/* The Saved Games folder (e.g. ...\Saved Games\DCS) as UTF-8 into out, from
   this DLL's own path: it is installed in <Saved Games>\Mods\Services\TRACS\bin,
   so this is exact for any DCS variant or -w folder. "" if the DLL isn't
   where the installer puts it. */
static void savedGamesDir(char *out, size_t n) {
  static const wchar_t SUFFIX[] = L"\\Mods\\Services\\TRACS\\bin\\";
  out[0] = 0;
  HMODULE self = NULL;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          (LPCWSTR)(void *)savedGamesDir, &self)) return;
  wchar_t path[MAX_PATH];
  DWORD len = GetModuleFileNameW(self, path, MAX_PATH);
  if (len == 0 || len >= MAX_PATH) return;
  /* The last match, case-insensitively: <Saved Games> is everything before it. */
  size_t sl = wcslen(SUFFIX);
  for (size_t i = len >= sl ? len - sl + 1 : 0; i-- > 0;) {
    if (_wcsnicmp(path + i, SUFFIX, sl) == 0) {
      path[i] = 0;
      if (!WideCharToMultiByte(CP_UTF8, 0, path, -1, out, (int)n, NULL, NULL)) out[0] = 0;
      return;
    }
  }
}

/* The mission file a host loaded, from DCS.getMissionFilename() ("" when
   it gives none, as on a multiplayer client). */
static void missionFilename(lua_State *L, char *out, size_t n) {
  out[0] = 0;
  int top = lua_gettop(L);
  push_path(L, "DCS.getMissionFilename");
  if (lua_pcall(L, 0, 1, 0) == 0 && lua_isstring(L, -1)) {
    _snprintf_s(out, n, _TRUNCATE, "%s", lua_tostring(L, -1));
  }
  lua_settop(L, top);
}

/* Wall clock, ms since 1970. */
static double epochMs(void) {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULARGE_INTEGER t;
  t.LowPart = ft.dwLowDateTime;
  t.HighPart = ft.dwHighDateTime;
  return (double)((t.QuadPart - 116444736000000000ULL) / 10000ULL);
}

/* The collectors and their rates (the relay's config can change both).
   Host: in the mission state, calling DCS in a private Lua state; contacts
   use the units collector's list of active units. Bullseyes rarely move
   (only when a script sets one); airbase ownership changes only on capture;
   TRACS runs the clock locally between updates, so it only corrects drift;
   fog animates; the mission weather never changes and goes once per resync;
   airfieldWeather goes once per resync in a static atmosphere and is
   re-sampled at its rate in a dynamic one. Client: in the same groups as the
   host's; units_client reads the export API's world objects in the private
   state; bullseyes come from the mission file (a script moving one isn't
   visible to a client). */
static const struct { const char *name, *side; double rate; const char *group; } COLLECTORS[] = {
  { "units", "server", 1, NULL },
  { "contacts", "server", 4, NULL },
  { "bullseyes", "server", 30, NULL },
  { "airbases", "server", 30, NULL },
  { "clock", "server", 15, NULL },
  { "weather", "server", 600, NULL },
  { "fog", "server", 60, NULL },
  { "airfieldWeather", "server", 600, NULL },
  { "units_client", "client", 1, "units" },
  { "exportStatus", "client", 5, NULL },
  { "bullseyes_client", "client", 30, "bullseyes" },
  { "airbases_client", "client", 30, "airbases" },
  { "clock_client", "client", 15, "clock" },
};

/* When the mission now loading began to load (ms since 1970), 0 if
   missionLoadBegin wasn't called. A client's multiplayer track is created
   at the start of the load, and loading the terrain can take far longer
   than any fixed allowance measured back from the load's end. */
static double g_loadBeginMs;

/* missionLoadBegin() from the hook's onMissionLoadBegin. */
static int l_missionLoadBegin(lua_State *L) {
  (void)L;
  g_loadBeginMs = epochMs();
  return 0;
}

/* missionLoad{ port, dllDir } from the hook's onMissionLoadEnd. dllDir is
   the folder the hook loaded this DLL from, for the mission state to load
   it from too. */
static int l_missionLoad(lua_State *L) {
  static int registered;
  luaL_checktype(L, 1, LUA_TTABLE);
  lua_getfield(L, 1, "port");
  int port = (int)luaL_checknumber(L, -1);
  lua_getfield(L, 1, "dllDir");
  const char *dllDir = luaL_checkstring(L, -1);

  if (!registered) {
    registered = 1;
    for (size_t i = 0; i < sizeof COLLECTORS / sizeof COLLECTORS[0]; i++) {
      if (!sched_registerNative(L, COLLECTORS[i].name, COLLECTORS[i].side, COLLECTORS[i].rate, COLLECTORS[i].group)) {
        dcs_log(L, LOG_ERROR, "no native collector named %s", COLLECTORS[i].name);
      }
    }
  }

  g_mission.loaded = 1;
  g_mission.server = dcsBool(L, "DCS.isServer");
  int multiplayer = dcsBool(L, "DCS.isMultiplayer");
  char theatre[64];
  missionTheatre(L, theatre, sizeof theatre);
  if (g_mission.server) initServer(L, dllDir);
  else initClient(L);
  g_mission.retryAt = now_s() + CLIENT_RETRY_S;
  logStatus(L);

  /* Where the relay finds this mission's file (it reads it, off the sim
     thread): a host's .miz, or for a client the track DCS writes in Saved
     Games at the join. */
  static char savedGames[3 * MAX_PATH], missionFile[3 * MAX_PATH];
  savedGamesDir(savedGames, sizeof savedGames);
  if (g_mission.server) missionFilename(L, missionFile, sizeof missionFile);
  else missionFile[0] = 0;
  MissionInfo info = { savedGames, missionFile, g_loadBeginMs > 0 ? g_loadBeginMs : epochMs() };
  g_loadBeginMs = 0;

  JBuf st;
  jb_init(&st);
  statusJson(&st);
  sched_start(L, port, g_mission.server, multiplayer, theatre, st.oom ? NULL : st.p, ready(), &info);
  jb_free(&st);
  dcs_log(L, LOG_INFO, "mission loaded - side=%s, relay port %d", g_mission.server ? "server" : "client", port);
  lua_settop(L, 1);
  return 0;
}

static void sendStatus(lua_State *L) {
  logStatus(L);
  JBuf st;
  jb_init(&st);
  statusJson(&st);
  sched_setStatus(L, st.oom ? NULL : st.p, ready());
  jb_free(&st);
}

/* frame() from every onSimulationFrame. Also where a pending client
   self-test is retried, and where a fault (caught in a collector or in the
   event handler, which stops DCS calls for the rest of the mission) reaches
   the relay as a fresh hello with ok false. */
static int l_frame(lua_State *L) {
  if (g_mission.loaded && g_mission.pending && now_s() >= g_mission.retryAt) {
    g_mission.retryAt = now_s() + CLIENT_RETRY_S;
    initClient(L);
    if (!g_mission.pending) sendStatus(L);
  }
  sched_frame(L);
  const Side *s = g_mission.server ? &g_server : &g_client;
  if (g_mission.loaded && g_mission.ok && s->faulted) {
    setError(s->error);
    sendStatus(L);
  }
  return 0;
}

/* stop() on mission end: disconnects from the relay and closes the private
   states. */
static int l_stop(lua_State *L) {
  (void)L;
  sched_stop();
  resetSide(&g_server);
  resetSide(&g_client);
  client_reset();
  server_reset(NULL);
  jb_free(&g_mission.selfTest);
  memset(&g_mission, 0, sizeof g_mission);
  return 0;
}

static const luaL_Reg FUNCTIONS[] = {
  { "initServer", l_initServer },
  { "missionLoadBegin", l_missionLoadBegin },
  { "missionLoad", l_missionLoad },
  { "frame", l_frame },
  { "stop", l_stop },
  { NULL, NULL },
};

/* Every C collector that can be registered by name: the client's and the
   server's. */
static const NativeCollector *nativeCollectors(void) {
  static NativeCollector all[32];
  if (all[0].name) return all;
  int n = 0;
  for (const NativeCollector *c = CLIENT_COLLECTORS; c->name && n < 31; c++) all[n++] = *c;
  for (const NativeCollector *c = SERVER_COLLECTORS; c->name && n < 31; c++) all[n++] = *c;
  return all;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
  (void)instance;
  (void)reserved;
  if (reason == DLL_PROCESS_ATTACH) net_init();
  return TRUE;
}

__declspec(dllexport) int luaopen_tracs_exporter(lua_State *L) {
  lua_newtable(L);
  luaL_register(L, NULL, FUNCTIONS);
  server_open(L);
  sched_open(L, nativeCollectors());
  lua_pushnumber(L, TRACS_EXPORTER_ABI);
  lua_setfield(L, -2, "abi");
  lua_pushstring(L, TRACS_VERSION);
  lua_setfield(L, -2, "version");
  return 1;
}
