/* Host-side units collector in C.

   Two halves sharing this file's globals (the DLL is mapped once per
   process, so the hook-state and mission-state copies see the same memory):

   - unitsStep(), in the mission state: one slice of a units cycle. Every DCS
     call runs in the server's private state (private.h) with units passed as
     bare { id_ } tables, so the mission state, where a garbage collection is
     a pause the player feels, gets almost nothing. The finished JSON stays in
     C memory; only a one-letter status goes back through Lua.
   - unitsServer(), in the hook state: the scheduler's native collector. It
     sets the step's parameters here, calls the mission state with a constant
     net.dostring_in chunk and picks the result up from C memory.

   What a cycle does is what the Lua collector did, shaped by the same
   garbage concerns:
   * The unit list comes from birth events (onBirth), with the groups
     re-listed every RELIST_CYCLES cycles (and on a full cycle) to catch
     anything missed.
   * Fields that never change are read once.
   * A unit on the ground and not moving only has its position checked (one
     getPoint); the full read happens when it has moved, and at least every
     FULL_READ_CYCLES cycles, which catches turning in place.
   Records are keyed by unit id (getID). Unlike the Lua collector's, they
   have no life0 (starting health): Unit.getLife0 is a Lua function in DCS,
   so it can't run in the private state, and nothing in TRACS shows the
   health percentage it was for. heading is atan2 of the unit's
   forward vector on the map grid, radians; converting it to true north is
   the consumer's job. pitch is the nose's angle above the horizon, radians. */

#define LUA_BUILD_AS_DLL
#include <windows.h>
#include <math.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "lua.h"
#include "lauxlib.h"
#include "common.h"
#include "private.h"
#include "server.h"

#define RELIST_CYCLES     30
#define FULL_READ_CYCLES  10
#define MIN_PER_STEP      50
#define MIN_GROUPS_STEP   10
#define CLEAR_EVERY       64   /* units between private-state clears */

#define UNITS_STEP_CODE "return TRACS_DLL and TRACS_DLL.unitsStep() or 'E'"

enum { R_FAULT = -1, R_FAIL = 0, R_OK = 1 };

/* One known unit: how to call DCS about it, its group details, and once it
   has been active its record as last sent. */
typedef struct {
  Id obj;
  double uid;
  int side, gcat;
  double gid;
  char *gname;
  int haveRec, gone, still;
  unsigned seen, fullAt;
  char *name, *type, *callsign, *player;
  double life;
  double lat, lon, alt, agl, heading, pitch, vx, vy, vz;
  int inAir;
  double px, py, pz;  /* position at the last full read, rounded */
} Unit;

typedef struct { double uid; int idx; } IndexEntry;
typedef struct { Id g; int side; } GroupRef;

static struct {
  Unit *p; int n, cap;
} g_units;

static struct {
  IndexEntry *p; int n, cap;
} g_index;   /* sorted by uid */

static struct {
  Id *p; int n, cap;
} g_births;  /* from onBirth, not looked at yet */

static struct {
  GroupRef *p; int n, cap;
} g_groups;  /* the re-list in progress */

static double g_unitCategory = 1;  /* Object.Category.UNIT */

/* The mission state while a step runs, and metatables (in its registry)
   giving rebuilt objects their class's methods, for Lua-implemented DCS
   functions. */
static lua_State *g_ML;
static int g_unitMt = LUA_NOREF, g_groupMt = LUA_NOREF;

/* The cycle in progress and its result, shared by both halves. */
static struct {
  int reqStart, reqFull, reqSlices;   /* set by the hook side per step */
  int active, full;
  unsigned cycle;
  int li, gi, perStep, groupsPerStep, relisting;
  int n, changed, first, lastUnitCount, births, relistAdded;
  JBuf parts;
  JBuf json;
  int removed;
  double kb0, kb1;
  char error[256];
} U;

/* ------------------------------------------------------------------ */
/* Private-state calls                                                  */
/* ------------------------------------------------------------------ */

static lua_State *P(void) { return g_server.P; }

static int call(int fn, int nargs, int nres) {
  int r = pcallPrivate(&g_server, fn, nargs, nres, NULL);
  return r == 2 ? R_FAULT : r == 0 ? R_OK : R_FAIL;
}

static void pushFn(int fn) { lua_pushcfunction(P(), g_server.fns[fn].fn); }

void server_pushObject(lua_State *ML, const Id *id, int isGroup) {
  pushBare(ML, id);
  int mt = isGroup ? g_groupMt : g_unitMt;
  if (mt == LUA_NOREF) return;
  lua_rawgeti(ML, LUA_REGISTRYINDEX, mt);
  lua_setmetatable(ML, -2);
}

/* A Lua-implemented fn(obj), called in the mission state; its result is
   copied onto the private stack (numbers, strings, booleans, and objects as
   bare tables), so callers read it the same way. */
static int callLuaObj(int fn, const Id *obj) {
  lua_State *ML = g_ML;
  if (!ML) return R_FAIL;
  int top = lua_gettop(ML);
  push_path(ML, g_server.fns[fn].path);
  server_pushObject(ML, obj, strncmp(g_server.fns[fn].path, "Group.", 6) == 0);
  int r = pcallShared(ML, &g_server, fn, 1, 1);
  if (r == 2) return R_FAULT;
  if (r == 1) { lua_settop(ML, top); return R_FAIL; }
  Id id;
  switch (lua_type(ML, -1)) {
    case LUA_TNUMBER: lua_pushnumber(P(), lua_tonumber(ML, -1)); break;
    case LUA_TSTRING: lua_pushstring(P(), lua_tostring(ML, -1)); break;
    case LUA_TBOOLEAN: lua_pushboolean(P(), lua_toboolean(ML, -1)); break;
    case LUA_TTABLE:
      if (readId(ML, -1, &id)) pushBare(P(), &id); else lua_pushnil(P());
      break;
    default: lua_pushnil(P()); break;
  }
  lua_settop(ML, top);
  return R_OK;
}

/* fn(obj) leaving one result on the private stack; on R_OK the caller pops
   it. */
static int callObj(int fn, const Id *obj) {
  if (g_server.fns[fn].isLua) return callLuaObj(fn, obj);
  int base = lua_gettop(P());
  pushFn(fn);
  pushBare(P(), obj);
  int r = call(fn, 1, 1);
  if (r == R_FAIL) lua_settop(P(), base);
  return r;
}

/* A number result; a numeric string counts (Unit.getID and Group.getID
   return the id as a string). */
static int objNum(int fn, const Id *obj, double *out) {
  int r = callObj(fn, obj);
  if (r != R_OK) return r;
  int ok = lua_isnumber(P(), -1);
  if (ok) *out = lua_tonumber(P(), -1);
  lua_pop(P(), 1);
  return ok ? R_OK : R_FAIL;
}

static int objBool(int fn, const Id *obj, int *out) {
  int r = callObj(fn, obj);
  if (r != R_OK) return r;
  *out = lua_toboolean(P(), -1);
  lua_pop(P(), 1);
  return R_OK;
}

/* A string result, copied (NULL for nil or a non-string). */
static int objStr(int fn, const Id *obj, char **out) {
  int r = callObj(fn, obj);
  if (r != R_OK) { *out = NULL; return r; }
  *out = lua_type(P(), -1) == LUA_TSTRING ? _strdup(lua_tostring(P(), -1)) : NULL;
  lua_pop(P(), 1);
  return R_OK;
}

static int objId(int fn, const Id *obj, Id *out) {
  int r = callObj(fn, obj);
  if (r != R_OK) return r;
  int ok = lua_istable(P(), -1) && readId(P(), -1, out);
  lua_pop(P(), 1);
  return ok ? R_OK : R_FAIL;
}

static double numAt(lua_State *L, int idx, const char *k) {
  lua_getfield(L, idx, k);
  double v = lua_tonumber(L, -1);
  lua_pop(L, 1);
  return v;
}

/* ------------------------------------------------------------------ */
/* The unit list                                                        */
/* ------------------------------------------------------------------ */

static double roundTo(double x, double step) { return floor(x / step + 0.5) * step; }

static int grow(void **p, int *cap, int need, size_t size) {
  if (need <= *cap) return 1;
  int c = *cap ? *cap : 64;
  while (c < need) c *= 2;
  void *q = realloc(*p, (size_t)c * size);
  if (!q) return 0;
  *p = q;
  *cap = c;
  return 1;
}

static void freeRec(Unit *u) {
  free(u->name); free(u->type); free(u->callsign); free(u->player);
  u->name = u->type = u->callsign = u->player = NULL;
  u->haveRec = 0;
}

static void freeUnit(Unit *u) {
  freeRec(u);
  free(u->gname);
  u->gname = NULL;
}

static int findIndex(double uid, int *at) {
  int lo = 0, hi = g_index.n - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    double v = g_index.p[mid].uid;
    if (v == uid) { *at = mid; return 1; }
    if (v < uid) lo = mid + 1; else hi = mid - 1;
  }
  *at = lo;
  return 0;
}

static int known(double uid) { int at; return findIndex(uid, &at); }

/* Adds a unit if it isn't known yet; gname is taken over. */
static int addUnit(const Id *obj, double uid, int side, double gid, char *gname, int gcat) {
  int at;
  if (findIndex(uid, &at)) { free(gname); return 0; }
  if (!grow((void **)&g_units.p, &g_units.cap, g_units.n + 1, sizeof *g_units.p) ||
      !grow((void **)&g_index.p, &g_index.cap, g_index.n + 1, sizeof *g_index.p)) {
    free(gname);
    return 0;
  }
  Unit *u = &g_units.p[g_units.n];
  memset(u, 0, sizeof *u);
  u->obj = *obj;
  u->uid = uid;
  u->side = side;
  u->gid = gid;
  u->gname = gname;
  u->gcat = gcat;
  memmove(&g_index.p[at + 1], &g_index.p[at], (size_t)(g_index.n - at) * sizeof *g_index.p);
  g_index.p[at].uid = uid;
  g_index.p[at].idx = g_units.n;
  g_index.n++;
  g_units.n++;
  return 1;
}

static int cmpIndex(const void *a, const void *b) {
  double x = ((const IndexEntry *)a)->uid, y = ((const IndexEntry *)b)->uid;
  return x < y ? -1 : x > y;
}

static void rebuildIndex(void) {
  g_index.n = 0;
  if (!grow((void **)&g_index.p, &g_index.cap, g_units.n, sizeof *g_index.p)) return;
  for (int i = 0; i < g_units.n; i++) {
    g_index.p[i].uid = g_units.p[i].uid;
    g_index.p[i].idx = i;
  }
  g_index.n = g_units.n;
  qsort(g_index.p, (size_t)g_index.n, sizeof *g_index.p, cmpIndex);
}

/* The group's id, name and category, for a unit about to be added. */
static int groupInfo(const Id *g, double *gid, char **gname, int *gcat) {
  double cat = 0;
  *gid = 0;
  *gname = NULL;
  int r = objNum(S_GROUP_GET_ID, g, gid);
  if (r == R_FAULT) return r;
  if ((r = objStr(S_GROUP_GET_NAME, g, gname)) == R_FAULT) return r;
  if ((r = objNum(S_GROUP_GET_CATEGORY, g, &cat)) == R_FAULT) { free(*gname); return r; }
  *gcat = (int)cat;
  return R_OK;
}

/* Units born since the last step. */
static int drainBirths(void) {
  for (int i = 0; i < g_births.n; i++) {
    const Id *o = &g_births.p[i];
    double cat, uid, side;
    Id g;
    int r = objNum(S_GET_CATEGORY, o, &cat);
    if (r == R_FAULT) return r;
    if (r != R_OK || cat != g_unitCategory) continue;
    if ((r = objNum(S_GET_ID, o, &uid)) == R_FAULT) return r;
    if (r != R_OK || known(uid)) continue;
    if ((r = objNum(S_GET_COALITION, o, &side)) == R_FAULT) return r;
    if (r != R_OK) continue;
    if ((r = objId(S_GET_GROUP, o, &g)) == R_FAULT) return r;
    if (r != R_OK) continue;
    double gid;
    char *gname;
    int gcat;
    if (groupInfo(&g, &gid, &gname, &gcat) == R_FAULT) return R_FAULT;
    if (addUnit(o, uid, (int)side, gid, gname, gcat)) U.births++;
  }
  g_births.n = 0;
  return R_OK;
}

/* Every group of every side, for the re-list. */
static int listGroups(void) {
  g_groups.n = 0;
  for (int side = 0; side <= 2; side++) {
    int base = lua_gettop(P());
    pushFn(S_GET_GROUPS);
    lua_pushnumber(P(), side);
    int r = call(S_GET_GROUPS, 1, 1);
    if (r == R_FAULT) return r;
    if (r == R_OK && lua_istable(P(), -1)) {
      int list = lua_gettop(P());
      int n = (int)lua_objlen(P(), list);
      for (int i = 1; i <= n; i++) {
        lua_rawgeti(P(), list, i);
        Id g;
        if (lua_istable(P(), -1) && readId(P(), -1, &g) &&
            grow((void **)&g_groups.p, &g_groups.cap, g_groups.n + 1, sizeof *g_groups.p)) {
          g_groups.p[g_groups.n].g = g;
          g_groups.p[g_groups.n].side = side;
          g_groups.n++;
        }
        lua_pop(P(), 1);
      }
    }
    lua_settop(P(), base);
  }
  clearPrivate(&g_server);
  return R_OK;
}

/* One slice of the re-list: units not known yet are added. */
static int relistSlice(void) {
  int last = U.gi + U.groupsPerStep;
  if (last > g_groups.n) last = g_groups.n;
  for (; U.gi < last; U.gi++) {
    const GroupRef *ge = &g_groups.p[U.gi];
    int base = lua_gettop(P());
    pushFn(S_GET_UNITS);
    pushBare(P(), &ge->g);
    int r = call(S_GET_UNITS, 1, 1);
    if (r == R_FAULT) return r;
    if (r == R_OK && lua_istable(P(), -1)) {
      int list = lua_gettop(P());
      int n = (int)lua_objlen(P(), list);
      int haveGroup = 0;
      double gid = 0;
      char *gname = NULL;
      int gcat = 0;
      for (int i = 1; i <= n; i++) {
        lua_rawgeti(P(), list, i);
        Id u;
        double uid;
        int ok = lua_istable(P(), -1) && readId(P(), -1, &u);
        lua_pop(P(), 1);
        if (!ok) continue;
        if ((r = objNum(S_GET_ID, &u, &uid)) == R_FAULT) { free(gname); return r; }
        if (r != R_OK || known(uid)) continue;
        if (!haveGroup) {
          if (groupInfo(&ge->g, &gid, &gname, &gcat) == R_FAULT) return R_FAULT;
          haveGroup = 1;
        }
        if (addUnit(&u, uid, ge->side, gid, gname ? _strdup(gname) : NULL, gcat) && U.cycle > 1) U.relistAdded++;
      }
      free(gname);
    }
    lua_settop(P(), base);
    clearPrivate(&g_server);
  }
  if (U.gi >= g_groups.n) U.relisting = 0;
  return R_OK;
}

/* ------------------------------------------------------------------ */
/* One unit                                                             */
/* ------------------------------------------------------------------ */

static void putNum(double *f, double v, int *changed) { if (*f != v) { *f = v; *changed = 1; } }
static void putInt(int *f, int v, int *changed) { if (*f != v) { *f = v; *changed = 1; } }

/* Takes over v. */
static void putStr(char **f, char *v, int *changed) {
  if ((*f == NULL) != (v == NULL) || (*f && strcmp(*f, v) != 0)) *changed = 1;
  free(*f);
  *f = v;
}

/* Appends the unit's context to a fault report. */
static void faultContext(const Unit *u) {
  char ctx[160];
  _snprintf_s(ctx, sizeof ctx, _TRUNCATE, " (unit %.0f %s)", u->uid, u->type ? u->type : "?");
  strncat_s(g_server.error, sizeof g_server.error, ctx, _TRUNCATE);
}

/* Refreshes a unit's record. 1 changed, 0 unchanged, -1 not active (gone
   set if it no longer exists) or not readable this cycle, -2 fault. */
static int updateUnit(Unit *u) {
  int b, r;
  if ((r = objBool(S_IS_EXIST, &u->obj, &b)) == R_FAULT) return -2;
  if (r != R_OK) return -1;
  if (!b) { u->gone = 1; return -1; }
  if ((r = objBool(S_IS_ACTIVE, &u->obj, &b)) == R_FAULT) return -2;
  if (r != R_OK || !b) return -1;

  int changed = 0;
  if (!u->haveRec) {
    if (objStr(S_GET_NAME, &u->obj, &u->name) == R_FAULT ||
        objStr(S_GET_TYPE_NAME, &u->obj, &u->type) == R_FAULT ||
        objStr(S_GET_CALLSIGN, &u->obj, &u->callsign) == R_FAULT) return -2;
    u->haveRec = 1;
    u->still = 0;
    changed = 1;
  }

  double life = 0;
  char *player = NULL;
  if (u->still && U.cycle - u->fullAt < FULL_READ_CYCLES) {
    int base = lua_gettop(P());
    if ((r = callObj(S_GET_POINT, &u->obj)) == R_FAULT) return -2;
    if (r == R_OK && lua_istable(P(), -1)) {
      int same = roundTo(numAt(P(), -1, "x"), 0.1) == u->px && roundTo(numAt(P(), -1, "y"), 0.1) == u->py &&
                 roundTo(numAt(P(), -1, "z"), 0.1) == u->pz;
      lua_settop(P(), base);
      if (same) {
        if ((r = objNum(S_GET_LIFE, &u->obj, &life)) == R_FAULT) return -2;
        if (r == R_OK) putNum(&u->life, life, &changed);
        if (objStr(S_GET_PLAYER_NAME, &u->obj, &player) == R_FAULT) return -2;
        putStr(&u->player, player, &changed);
        return changed;
      }
    }
    lua_settop(P(), base);
  }

  /* The full read: every value first, then the record. */
  int base = lua_gettop(P());
  double px, py, pz, fx, fy, fz, lat, lon, alt, ground = 0, vx, vy, vz;
  if ((r = callObj(S_GET_POSITION, &u->obj)) == R_FAULT) return -2;
  if (r != R_OK || !lua_istable(P(), -1)) { lua_settop(P(), base); return -1; }
  lua_getfield(P(), -1, "p");
  lua_getfield(P(), -2, "x");
  if (!lua_istable(P(), -2) || !lua_istable(P(), -1)) { lua_settop(P(), base); return -1; }
  px = numAt(P(), -2, "x"); py = numAt(P(), -2, "y"); pz = numAt(P(), -2, "z");
  fx = numAt(P(), -1, "x"); fy = numAt(P(), -1, "y"); fz = numAt(P(), -1, "z");
  lua_settop(P(), base);

  pushFn(S_LO_TO_LL);
  lua_createtable(P(), 0, 3);
  lua_pushnumber(P(), px); lua_setfield(P(), -2, "x");
  lua_pushnumber(P(), py); lua_setfield(P(), -2, "y");
  lua_pushnumber(P(), pz); lua_setfield(P(), -2, "z");
  if ((r = call(S_LO_TO_LL, 1, 3)) == R_FAULT) return -2;
  if (r != R_OK) { lua_settop(P(), base); return -1; }
  lat = lua_tonumber(P(), -3); lon = lua_tonumber(P(), -2); alt = lua_tonumber(P(), -1);
  lua_settop(P(), base);

  pushFn(S_GET_HEIGHT);
  lua_createtable(P(), 0, 2);
  lua_pushnumber(P(), px); lua_setfield(P(), -2, "x");
  lua_pushnumber(P(), pz); lua_setfield(P(), -2, "y");
  if ((r = call(S_GET_HEIGHT, 1, 1)) == R_FAULT) return -2;
  if (r == R_OK) ground = lua_tonumber(P(), -1);
  lua_settop(P(), base);

  if ((r = callObj(S_GET_VELOCITY, &u->obj)) == R_FAULT) return -2;
  if (r != R_OK || !lua_istable(P(), -1)) { lua_settop(P(), base); return -1; }
  vx = numAt(P(), -1, "x"); vy = numAt(P(), -1, "y"); vz = numAt(P(), -1, "z");
  lua_settop(P(), base);

  int inAir = 0;
  if ((r = objBool(S_IN_AIR, &u->obj, &inAir)) == R_FAULT) return -2;
  if ((r = objNum(S_GET_LIFE, &u->obj, &life)) == R_FAULT) return -2;
  int haveLife = r == R_OK;
  if (objStr(S_GET_PLAYER_NAME, &u->obj, &player) == R_FAULT) return -2;

  if (fy < -1) fy = -1;
  if (fy > 1) fy = 1;
  putNum(&u->lat, roundTo(lat, 1e-6), &changed);
  putNum(&u->lon, roundTo(lon, 1e-6), &changed);
  putNum(&u->alt, roundTo(alt, 0.1), &changed);
  putNum(&u->agl, roundTo(alt - ground, 0.1), &changed);
  putNum(&u->heading, roundTo(atan2(fz, fx), 1e-3), &changed);
  putNum(&u->pitch, roundTo(asin(fy), 1e-3), &changed);
  putNum(&u->vx, roundTo(vx, 0.01), &changed);
  putNum(&u->vy, roundTo(vy, 0.01), &changed);
  putNum(&u->vz, roundTo(vz, 0.01), &changed);
  putInt(&u->inAir, inAir, &changed);
  if (haveLife) putNum(&u->life, life, &changed);
  putStr(&u->player, player, &changed);
  u->px = roundTo(px, 0.1); u->py = roundTo(py, 0.1); u->pz = roundTo(pz, 0.1);
  u->still = !u->inAir && u->vx == 0 && u->vy == 0 && u->vz == 0;
  u->fullAt = U.cycle;
  return changed;
}

static void keyJson(JBuf *b, double uid) {
  char key[32];
  _snprintf_s(key, sizeof key, _TRUNCATE, "%.14g", uid);
  jb_str(b, key);
}

static void optStr(JBuf *b, const char *k, const char *v) {
  if (!v) return;
  jb_puts(b, ",\"");
  jb_puts(b, k);
  jb_puts(b, "\":");
  jb_str(b, v);
}

static void writeRec(JBuf *b, const Unit *u) {
  keyJson(b, u->uid);
  jb_printf(b, ":{\"coalition\":%d,\"groupId\":", u->side);
  jb_num(b, u->gid);
  jb_printf(b, ",\"category\":%d", u->gcat);
  optStr(b, "name", u->name);
  optStr(b, "type", u->type);
  optStr(b, "groupName", u->gname);
  optStr(b, "callsign", u->callsign);
  jb_puts(b, ",\"lat\":"); jb_num(b, u->lat);
  jb_puts(b, ",\"lon\":"); jb_num(b, u->lon);
  jb_puts(b, ",\"alt\":"); jb_num(b, u->alt);
  jb_puts(b, ",\"agl\":"); jb_num(b, u->agl);
  jb_puts(b, ",\"heading\":"); jb_num(b, u->heading);
  jb_puts(b, ",\"pitch\":"); jb_num(b, u->pitch);
  jb_puts(b, ",\"vx\":"); jb_num(b, u->vx);
  jb_puts(b, ",\"vy\":"); jb_num(b, u->vy);
  jb_puts(b, ",\"vz\":"); jb_num(b, u->vz);
  jb_puts(b, u->inAir ? ",\"inAir\":true" : ",\"inAir\":false");
  jb_puts(b, ",\"life\":"); jb_num(b, u->life);
  optStr(b, "player", u->player);
  jb_puts(b, "}");
}

static void comma(void) {
  if (!U.first) jb_puts(&U.parts, ",");
  U.first = 0;
}

/* ------------------------------------------------------------------ */
/* The cycle                                                            */
/* ------------------------------------------------------------------ */

static int startCycle(int full, int slices) {
  U.cycle++;
  U.active = 1;
  U.full = full;
  U.li = 0;
  U.n = U.changed = 0;
  U.first = 1;
  U.parts.len = 0;
  if (U.parts.p) U.parts.p[0] = 0;
  U.parts.oom = 0;
  int per = (U.lastUnitCount + slices - 1) / slices;
  U.perStep = per > MIN_PER_STEP ? per : MIN_PER_STEP;
  U.relisting = 0;
  if (full || U.cycle % RELIST_CYCLES == 1) {
    if (listGroups() == R_FAULT) return R_FAULT;
    U.gi = 0;
    U.relisting = g_groups.n > 0;
    int gps = (g_groups.n + slices - 1) / slices;
    U.groupsPerStep = gps > MIN_GROUPS_STEP ? gps : MIN_GROUPS_STEP;
  }
  return R_OK;
}

/* Records not seen this cycle are gone or inactive; a full cycle replaces
   everything, so only a delta names them. Units that no longer exist leave
   the list. */
static void finishCycle(void) {
  int keep = 0;
  U.removed = 0;
  for (int i = 0; i < g_units.n; i++) {
    Unit *u = &g_units.p[i];
    if (u->haveRec && u->seen != U.cycle) {
      if (!U.full) {
        comma();
        keyJson(&U.parts, u->uid);
        jb_puts(&U.parts, ":null");
        U.removed++;
      }
      freeRec(u);
    }
    if (u->gone) { freeUnit(u); continue; }
    g_units.p[keep++] = *u;
  }
  g_units.n = keep;
  rebuildIndex();

  jb_free(&U.json);
  jb_puts(&U.json, "{");
  if (U.parts.len) jb_put(&U.json, U.parts.p, U.parts.len);
  jb_puts(&U.json, "}");
  if (U.parts.oom) U.json.oom = 1;
  U.lastUnitCount = U.n;
  U.active = 0;
}

/* unitsStep() in the mission state: one slice of a cycle. Returns "P" while
   the cycle runs, "F" or "D" when its JSON is ready, "X" after a caught
   exception (report in g_server.error), "E" on any other failure (U.error). */
static int l_unitsStep(lua_State *L) {
  g_ML = L;
  U.kb0 = lua_gc(L, LUA_GCCOUNT, 0);
  const char *status = "E";
  if (!g_server.ready || g_server.faulted || !g_server.P) {
    _snprintf_s(U.error, sizeof U.error, _TRUNCATE, "the DLL is not ready in the mission environment");
    goto out;
  }
  int slices = U.reqSlices > 1 ? U.reqSlices : 1;
  if ((U.reqStart || !U.active) && startCycle(U.reqFull, slices) == R_FAULT) goto fault;
  if (drainBirths() == R_FAULT) goto fault;
  if (U.relisting && relistSlice() == R_FAULT) goto fault;

  for (int done = 0; done < U.perStep && U.li < g_units.n; done++) {
    Unit *u = &g_units.p[U.li++];
    int r = updateUnit(u);
    if (r == -2) { faultContext(u); goto fault; }
    if (r >= 0) {
      u->seen = U.cycle;
      U.n++;
      if (U.full || r == 1) {
        comma();
        writeRec(&U.parts, u);
        U.changed++;
      }
    }
    if ((done + 1) % CLEAR_EVERY == 0) clearPrivate(&g_server);
  }
  clearPrivate(&g_server);
  if (U.relisting || U.li < g_units.n) { status = "P"; goto out; }
  finishCycle();
  status = U.full ? "F" : "D";
  goto out;

fault:
  U.active = 0;
  status = "X";
out:
  g_ML = NULL;
  U.kb1 = lua_gc(L, LUA_GCCOUNT, 0);
  lua_pushstring(L, status);
  return 1;
}

/* onBirth(unit) from the mission's event handler: noted, looked at in the
   next step. */
static int l_onBirth(lua_State *L) {
  Id id;
  if (lua_istable(L, 1) && readId(L, 1, &id) &&
      grow((void **)&g_births.p, &g_births.cap, g_births.n + 1, sizeof *g_births.p)) {
    g_births.p[g_births.n++] = id;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* Contacts                                                             */
/* ------------------------------------------------------------------ */

/* Which enemy units each coalition's units detect, from DCS itself, a slice
   of the unit list per tick. Every red and blue unit active at the units
   collector's last cycle (or, with sensorUnitsOnly, only those whose type
   has sensors, checked once per type) is asked for its detected targets
   once per detection method, as Olympus does. Targets on the detector's own
   side are dropped; the rest are merged per coalition into one flat map:
   '<coalition>:<target unit id>' -> the sum of the method bits that found it
   (VISUAL 1, OPTIC 2, RADAR 4, IRST 8, RWR 16, DLINK 32, Olympus's values).
   Flat, so the relay's one-level delta merge works. A delta names changed
   entries, and lost ones as null. */

#define MIN_DETECTORS_STEP 20
/* A step stops taking detectors once it has run this long, so the units
   that see the most (radar and datalink aircraft, which the unit list tends
   to bunch together) spread over several steps instead of one heavy frame.
   A busy cycle then takes a few more steps than its slices. */
#define STEP_BUDGET_MS 0.5
#define CONTACTS_STEP_CODE "return TRACS_DLL and TRACS_DLL.contactsStep() or 'E'"

static const struct { const char *name; int bit; } DETECTION_BITS[] = {
  { "VISUAL", 1 }, { "OPTIC", 2 }, { "RADAR", 4 }, { "IRST", 8 }, { "RWR", 16 }, { "DLINK", 32 },
};
#define N_METHODS ((int)(sizeof DETECTION_BITS / sizeof DETECTION_BITS[0]))

/* Controller.Detection's value for each method (0: this DCS lacks it). */
static double g_methods[N_METHODS];

/* side:id -> method bits, open addressing; key 0 is empty (a side is 1 or
   2, so no real key is 0). */
typedef struct { unsigned long long key; int mask; } MaskEntry;
typedef struct { MaskEntry *p; int n, cap; } MaskMap;

static unsigned long long maskKey(int side, double id) {
  return ((unsigned long long)side << 40) | ((unsigned long long)id & 0xFFFFFFFFFFULL);
}

static unsigned hashKey(unsigned long long k) {
  k ^= k >> 33;
  k *= 0xff51afd7ed558ccdULL;
  k ^= k >> 33;
  return (unsigned)k;
}

static MaskEntry *mapSlot(const MaskMap *m, unsigned long long key) {
  unsigned mask = (unsigned)m->cap - 1, i = hashKey(key) & mask;
  while (m->p[i].key && m->p[i].key != key) i = (i + 1) & mask;
  return &m->p[i];
}

static int mapGrow(MaskMap *m) {
  int cap = m->cap ? m->cap * 2 : 1024;
  MaskEntry *p = calloc((size_t)cap, sizeof *p);
  if (!p) return 0;
  MaskMap next = { p, 0, cap };
  for (int i = 0; i < m->cap; i++) {
    if (!m->p[i].key) continue;
    *mapSlot(&next, m->p[i].key) = m->p[i];
    next.n++;
  }
  free(m->p);
  *m = next;
  return 1;
}

static void mapOr(MaskMap *m, unsigned long long key, int bit) {
  if ((m->n + 1) * 2 > m->cap && !mapGrow(m)) return;
  MaskEntry *e = mapSlot(m, key);
  if (!e->key) { e->key = key; e->mask = 0; m->n++; }
  e->mask |= bit;
}

static int mapGet(const MaskMap *m, unsigned long long key) {
  if (!m->cap) return 0;
  const MaskEntry *e = mapSlot(m, key);
  return e->key ? e->mask : 0;
}

static void mapClear(MaskMap *m) {
  if (m->p) memset(m->p, 0, (size_t)m->cap * sizeof *m->p);
  m->n = 0;
}

/* What a target is, looked up once per cycle however many detectors see it
   (datalink gives a whole coalition the same picture). Keyed by the
   object's handle; emptied at each cycle's start, so nothing about a target
   outlives the cycle it was read in. Whether a target is detected is never
   cached. */
typedef struct { unsigned long long key; int use; int side; double id; } TargetEntry;
typedef struct { TargetEntry *p; int n, cap; } TargetMap;

static unsigned long long targetKey(const Id *obj) {
  unsigned long long k = obj->type == LUA_TNUMBER ? (unsigned long long)obj->num : (unsigned long long)(uintptr_t)obj->ptr;
  return (k & 0x3FFFFFFFFFFFFFFFULL) | (obj->type == LUA_TNUMBER ? 1ULL << 62 : 1ULL << 63);
}

static TargetEntry *targetSlot(const TargetMap *m, unsigned long long key) {
  unsigned mask = (unsigned)m->cap - 1, i = hashKey(key) & mask;
  while (m->p[i].key && m->p[i].key != key) i = (i + 1) & mask;
  return &m->p[i];
}

static int targetGrow(TargetMap *m) {
  int cap = m->cap ? m->cap * 2 : 1024;
  TargetEntry *p = calloc((size_t)cap, sizeof *p);
  if (!p) return 0;
  TargetMap next = { p, 0, cap };
  for (int i = 0; i < m->cap; i++) {
    if (!m->p[i].key) continue;
    *targetSlot(&next, m->p[i].key) = m->p[i];
    next.n++;
  }
  free(m->p);
  *m = next;
  return 1;
}

static void targetClear(TargetMap *m) {
  if (m->p) memset(m->p, 0, (size_t)m->cap * sizeof *m->p);
  m->n = 0;
}

/* A detector as of the cycle's start (the unit list itself may change
   between steps). */
typedef struct { Id obj; int side; char type[64]; } Detector;

/* hasSensors per unit type, asked once. */
typedef struct { char type[64]; int has; } SensorType;

static struct {
  int reqStart, reqFull, reqSlices, reqSensorOnly;
  int active, full;
  Detector *list;
  int n, cap, li, perStep;
  SensorType *types;
  int nTypes, capTypes;
  MaskMap acc, sent;
  TargetMap targets;
  int detectors, entries, changed;
  JBuf json;
  double kb0, kb1;
  char error[256];
} C;

/* Milliseconds, for the step budget. */
static double nowMs(void) {
  static LARGE_INTEGER f;
  LARGE_INTEGER c;
  if (!f.QuadPart) QueryPerformanceFrequency(&f);
  QueryPerformanceCounter(&c);
  return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
}

static void contacts_reset(void) {
  C.active = 0;
  C.n = C.li = C.nTypes = 0;
  mapClear(&C.acc);
  mapClear(&C.sent);
  targetClear(&C.targets);
  jb_free(&C.json);
}

/* A failed check counts as having sensors, so a unit is asked rather than
   silently skipped. */
static int hasSensors(const Detector *d, int *fault) {
  for (int i = 0; i < C.nTypes; i++) {
    if (strcmp(C.types[i].type, d->type) == 0) return C.types[i].has;
  }
  int has = 1, b;
  int r = objBool(S_HAS_SENSORS, &d->obj, &b);
  if (r == R_FAULT) { *fault = 1; return 0; }
  if (r == R_OK) has = b;
  if (grow((void **)&C.types, &C.capTypes, C.nTypes + 1, sizeof *C.types)) {
    strncpy_s(C.types[C.nTypes].type, sizeof C.types[C.nTypes].type, d->type, _TRUNCATE);
    C.types[C.nTypes].has = has;
    C.nTypes++;
  }
  return has;
}

/* The target's side and id, from the cache or asked once. *out is NULL
   only when the cache can't grow (the target is then skipped); use 0 means
   not a unit, or unreadable. */
static int lookupTarget(const Id *obj, const TargetEntry **out) {
  *out = NULL;
  unsigned long long key = targetKey(obj);
  if (C.targets.cap) {
    TargetEntry *e = targetSlot(&C.targets, key);
    if (e->key) { *out = e; return R_OK; }
  }
  if ((C.targets.n + 1) * 2 > C.targets.cap && !targetGrow(&C.targets)) return R_OK;
  TargetEntry v = { key, 0, 0, 0 };
  double cat, side, id;
  int r;
  if ((r = objNum(S_GET_CATEGORY, obj, &cat)) == R_FAULT) return r;
  if (r == R_OK) {
    if (cat == g_unitCategory) {
      if ((r = objNum(S_GET_COALITION, obj, &side)) == R_FAULT) return r;
      if (r == R_OK) {
        if ((r = objNum(S_GET_ID, obj, &id)) == R_FAULT) return r;
        if (r == R_OK) { v.use = 1; v.side = (int)side; v.id = id; }
      }
    }
  }
  TargetEntry *e = targetSlot(&C.targets, key);
  *e = v;
  C.targets.n++;
  *out = e;
  return R_OK;
}

/* One detector's targets into C.acc. R_FAULT stops the cycle; any other
   failure just skips what failed. */
static int detectInto(const Detector *d) {
  int exists, r;
  if ((r = objBool(S_IS_EXIST, &d->obj, &exists)) != R_OK) return r;
  if (!exists) return R_FAIL;
  Id ctrl;
  if ((r = objId(S_GET_CONTROLLER, &d->obj, &ctrl)) != R_OK) return r;
  for (int m = 0; m < N_METHODS; m++) {
    if (!g_methods[m]) continue;
    int base = lua_gettop(P());
    pushFn(S_GET_DETECTED_TARGETS);
    pushBare(P(), &ctrl);
    lua_pushnumber(P(), g_methods[m]);
    if ((r = call(S_GET_DETECTED_TARGETS, 2, 1)) == R_FAULT) return r;
    if (r == R_OK && lua_istable(P(), -1)) {
      int list = lua_gettop(P());
      int n = (int)lua_objlen(P(), list);
      for (int i = 1; i <= n; i++) {
        lua_rawgeti(P(), list, i);
        Id obj;
        int ok = 0;
        if (lua_istable(P(), -1)) {
          lua_getfield(P(), -1, "visible");
          int visible = lua_toboolean(P(), -1);
          lua_pop(P(), 1);
          lua_getfield(P(), -1, "object");
          ok = visible && lua_istable(P(), -1) && readId(P(), -1, &obj);
          lua_pop(P(), 1);
        }
        lua_pop(P(), 1);
        if (!ok) continue;
        const TargetEntry *t;
        if ((r = lookupTarget(&obj, &t)) == R_FAULT) return r;
        if (!t || !t->use) continue;
        if (t->side == d->side) continue;
        mapOr(&C.acc, maskKey(d->side, t->id), DETECTION_BITS[m].bit);
      }
    }
    lua_settop(P(), base);
  }
  return R_OK;
}

static void startContacts(int full, int slices) {
  C.active = 1;
  C.full = full;
  C.li = C.n = 0;
  C.detectors = C.entries = C.changed = 0;
  targetClear(&C.targets);
  mapClear(&C.acc);
  for (int i = 0; i < g_units.n; i++) {
    const Unit *u = &g_units.p[i];
    if (!u->haveRec || u->gone || (u->side != 1 && u->side != 2)) continue;
    if (!grow((void **)&C.list, &C.cap, C.n + 1, sizeof *C.list)) break;
    Detector *d = &C.list[C.n++];
    d->obj = u->obj;
    d->side = u->side;
    strncpy_s(d->type, sizeof d->type, u->type ? u->type : "?", _TRUNCATE);
  }
  int per = (C.n + slices - 1) / slices;
  C.perStep = per > MIN_DETECTORS_STEP ? per : MIN_DETECTORS_STEP;
}

static void putMaskKey(JBuf *b, int *first, unsigned long long key) {
  char k[48];
  _snprintf_s(k, sizeof k, _TRUNCATE, "%d:%.0f", (int)(key >> 40), (double)(key & 0xFFFFFFFFFFULL));
  if (!*first) jb_puts(b, ",");
  *first = 0;
  jb_str(b, k);
}

static void finishContacts(void) {
  int first = 1;
  jb_free(&C.json);
  jb_puts(&C.json, "{");
  for (int i = 0; i < C.acc.cap; i++) {
    const MaskEntry *e = &C.acc.p[i];
    if (!e->key) continue;
    C.entries++;
    if (C.full || mapGet(&C.sent, e->key) != e->mask) {
      putMaskKey(&C.json, &first, e->key);
      jb_printf(&C.json, ":%d", e->mask);
      C.changed++;
    }
  }
  if (!C.full) {
    for (int i = 0; i < C.sent.cap; i++) {
      const MaskEntry *e = &C.sent.p[i];
      if (!e->key || mapGet(&C.acc, e->key)) continue;
      putMaskKey(&C.json, &first, e->key);
      jb_puts(&C.json, ":null");
      C.changed++;
    }
  }
  jb_puts(&C.json, "}");
  MaskMap t = C.sent;
  C.sent = C.acc;
  C.acc = t;
  C.active = 0;
}

/* contactsStep() in the mission state; same statuses as unitsStep. */
static int l_contactsStep(lua_State *L) {
  g_ML = L;
  C.kb0 = lua_gc(L, LUA_GCCOUNT, 0);
  const char *status = "E";
  if (!g_server.ready || g_server.faulted || !g_server.P) {
    _snprintf_s(C.error, sizeof C.error, _TRUNCATE, "the DLL is not ready in the mission environment");
    goto out;
  }
  if (C.reqStart || !C.active) startContacts(C.reqFull, C.reqSlices > 1 ? C.reqSlices : 1);
  double stepStart = nowMs();
  for (int done = 0; done < C.perStep && C.li < C.n; done++) {
    if (done > 0 && nowMs() - stepStart >= STEP_BUDGET_MS) break;
    const Detector *d = &C.list[C.li++];
    if (C.reqSensorOnly) {
      int fault = 0;
      int has = hasSensors(d, &fault);
      if (fault) goto fault;
      if (!has) continue;
    }
    C.detectors++;
    if (detectInto(d) == R_FAULT) {
      char ctx[96];
      _snprintf_s(ctx, sizeof ctx, _TRUNCATE, " (detector %s)", d->type);
      strncat_s(g_server.error, sizeof g_server.error, ctx, _TRUNCATE);
      goto fault;
    }
    if ((done + 1) % CLEAR_EVERY == 0) clearPrivate(&g_server);
  }
  clearPrivate(&g_server);
  if (C.li < C.n) {
    status = "P";
  } else {
    finishContacts();
    status = C.full ? "F" : "D";
  }
  goto out;

fault:
  C.active = 0;
  status = "X";
out:
  g_ML = NULL;
  C.kb1 = lua_gc(L, LUA_GCCOUNT, 0);
  lua_pushstring(L, status);
  return 1;
}

/* ------------------------------------------------------------------ */
/* Hook side                                                            */
/* ------------------------------------------------------------------ */

/* Runs one mission-state step (code returns a one-letter status) and
   returns that letter, or 'E' with the reason in err. */
static char missionStep(lua_State *L, const char *code, char *err, size_t errLen) {
  int top = lua_gettop(L);
  push_path(L, "net.dostring_in");
  if (!lua_isfunction(L, -1)) {
    lua_settop(L, top);
    _snprintf_s(err, errLen, _TRUNCATE, "net.dostring_in is missing");
    return 'E';
  }
  lua_pushstring(L, "server");
  lua_pushstring(L, code);
  int ok = lua_pcall(L, 2, 1, 0) == 0;
  char status = ok && lua_type(L, -1) == LUA_TSTRING ? lua_tostring(L, -1)[0] : 0;
  if (!ok || !status) {
    _snprintf_s(err, errLen, _TRUNCATE, "step failed: %s", lua_isstring(L, -1) ? lua_tostring(L, -1) : "no result");
    status = 'E';
  }
  lua_settop(L, top);
  return status;
}

/* The scheduler's answer for a step's status; on 'F'/'D' the caller has
   already moved its JSON into r->out. */
static int stepResult(char status, NativeRun *r, char *err, size_t errLen, const char *what) {
  switch (status) {
    case 'P':
      return 2;
    case 'F':
    case 'D':
      r->kind = status == 'F' ? "full" : "delta";
      return 1;
    case 'X':
      r->error = g_server.error;
      r->fatal = 1;
      return -1;
    default:
      if (!err[0]) _snprintf_s(err, errLen, _TRUNCATE, "%s step failed (mission environment not bootstrapped?)", what);
      r->error = err;
      return -1;
  }
}

static int unitsServer(lua_State *L, NativeRun *r) {
  if (!g_server.ready || g_server.faulted) return 0;
  U.error[0] = 0;
  U.reqStart = r->start;
  U.reqFull = r->full;
  U.reqSlices = r->slices;
  char status = missionStep(L, UNITS_STEP_CODE, U.error, sizeof U.error);
  r->srvKb0 = U.kb0;
  r->srvKb1 = U.kb1;
  if (status == 'F' || status == 'D') {
    if (U.json.oom) { r->error = "out of memory building the units JSON"; return -1; }
    jb_put(r->out, U.json.p, U.json.len);
    jb_free(&U.json);
    jb_printf(r->extra, ",\"units\":%d,\"changed\":%d,\"removed\":%d,\"births\":%d,\"relistAdded\":%d",
              U.n, U.changed, U.removed, U.births, U.relistAdded);
    U.births = U.relistAdded = 0;
  }
  return stepResult(status, r, U.error, sizeof U.error, "units");
}

static int contactsServer(lua_State *L, NativeRun *r) {
  if (!g_server.ready || g_server.faulted) return 0;
  C.error[0] = 0;
  C.reqStart = r->start;
  C.reqFull = r->full;
  C.reqSlices = r->slices;
  C.reqSensorOnly = r->sensorUnitsOnly;
  char status = missionStep(L, CONTACTS_STEP_CODE, C.error, sizeof C.error);
  r->srvKb0 = C.kb0;
  r->srvKb1 = C.kb1;
  if (status == 'F' || status == 'D') {
    if (C.json.oom) { r->error = "out of memory building the contacts JSON"; return -1; }
    jb_put(r->out, C.json.p, C.json.len);
    jb_free(&C.json);
    jb_printf(r->extra, ",\"detectors\":%d,\"entries\":%d,\"changed\":%d", C.detectors, C.entries, C.changed);
  }
  return stepResult(status, r, C.error, sizeof C.error, "contacts");
}

/* ------------------------------------------------------------------ */

void server_reset(lua_State *L) {
  for (int i = 0; i < g_units.n; i++) freeUnit(&g_units.p[i]);
  g_units.n = g_index.n = g_births.n = g_groups.n = 0;
  jb_free(&U.parts);
  jb_free(&U.json);
  memset(&U, 0, sizeof U);
  contacts_reset();
  g_ML = NULL;
  /* The previous mission state's references die with it. */
  g_unitMt = g_groupMt = LUA_NOREF;
  if (L) {
    static const char *CLASSES[] = { "Unit", "Group" };
    for (int i = 0; i < 2; i++) {
      lua_createtable(L, 0, 1);
      lua_getglobal(L, CLASSES[i]);
      lua_setfield(L, -2, "__index");
      int ref = luaL_ref(L, LUA_REGISTRYINDEX);
      if (i == 0) g_unitMt = ref; else g_groupMt = ref;
    }
    push_path(L, "Controller.Detection");
    for (int m = 0; m < N_METHODS; m++) {
      g_methods[m] = 0;
      if (!lua_istable(L, -1)) continue;
      lua_getfield(L, -1, DETECTION_BITS[m].name);
      if (lua_type(L, -1) == LUA_TNUMBER) g_methods[m] = lua_tonumber(L, -1);
      lua_pop(L, 1);
    }
    lua_pop(L, 1);
    push_path(L, "Object.Category");
    if (lua_istable(L, -1)) {
      lua_getfield(L, -1, "UNIT");
      if (lua_type(L, -1) == LUA_TNUMBER) g_unitCategory = lua_tonumber(L, -1);
      lua_pop(L, 1);
    }
    lua_pop(L, 1);
  }
}

static const luaL_Reg FUNCTIONS[] = {
  { "unitsStep", l_unitsStep },
  { "onBirth", l_onBirth },
  { "contactsStep", l_contactsStep },
  { NULL, NULL },
};

void server_open(lua_State *L) {
  luaL_register(L, NULL, FUNCTIONS);
}

const NativeCollector SERVER_COLLECTORS[] = {
  { "units", unitsServer, 1 },
  { "contacts", contactsServer, 1 },
  { NULL, NULL, 0 },
};
