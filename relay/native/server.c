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

/* activeUnits() in the mission state: { { u = <bare unit>, side, type }, ... }
   for the red and blue units active at the last cycle. For the Lua contacts
   collector until it moves to C. */
static int l_activeUnits(lua_State *L) {
  lua_createtable(L, 0, 0);
  int n = 0;
  for (int i = 0; i < g_units.n; i++) {
    const Unit *u = &g_units.p[i];
    if (!u->haveRec || u->gone || (u->side != 1 && u->side != 2)) continue;
    lua_createtable(L, 0, 3);
    pushBare(L, &u->obj);
    lua_setfield(L, -2, "u");
    lua_pushnumber(L, u->side);
    lua_setfield(L, -2, "side");
    if (u->type) { lua_pushstring(L, u->type); lua_setfield(L, -2, "type"); }
    lua_rawseti(L, -2, ++n);
  }
  return 1;
}

/* ------------------------------------------------------------------ */
/* Hook side                                                            */
/* ------------------------------------------------------------------ */

static int unitsServer(lua_State *L, NativeRun *r) {
  if (!g_server.ready || g_server.faulted) return 0;
  U.error[0] = 0;
  U.reqStart = r->start;
  U.reqFull = r->full;
  U.reqSlices = r->slices;
  int top = lua_gettop(L);
  push_path(L, "net.dostring_in");
  if (!lua_isfunction(L, -1)) {
    lua_settop(L, top);
    r->error = "net.dostring_in is missing";
    return -1;
  }
  lua_pushstring(L, "server");
  lua_pushstring(L, UNITS_STEP_CODE);
  int ok = lua_pcall(L, 2, 1, 0) == 0;
  char status = ok && lua_type(L, -1) == LUA_TSTRING ? lua_tostring(L, -1)[0] : 0;
  if (!ok || !status) {
    _snprintf_s(U.error, sizeof U.error, _TRUNCATE, "units step failed: %s",
                lua_isstring(L, -1) ? lua_tostring(L, -1) : "no result");
    status = 'E';
  }
  lua_settop(L, top);
  r->srvKb0 = U.kb0;
  r->srvKb1 = U.kb1;

  switch (status) {
    case 'P':
      return 2;
    case 'F':
    case 'D':
      if (U.json.oom) { r->error = "out of memory building the units JSON"; return -1; }
      jb_put(r->out, U.json.p, U.json.len);
      jb_free(&U.json);
      r->kind = status == 'F' ? "full" : "delta";
      jb_printf(r->extra, ",\"units\":%d,\"changed\":%d,\"removed\":%d,\"births\":%d,\"relistAdded\":%d",
                U.n, U.changed, U.removed, U.births, U.relistAdded);
      U.births = U.relistAdded = 0;
      return 1;
    case 'X':
      r->error = g_server.error;
      r->fatal = 1;
      return -1;
    default:
      if (!U.error[0]) _snprintf_s(U.error, sizeof U.error, _TRUNCATE, "units step failed (mission environment not bootstrapped?)");
      r->error = U.error;
      return -1;
  }
}

/* ------------------------------------------------------------------ */

void server_reset(lua_State *L) {
  for (int i = 0; i < g_units.n; i++) freeUnit(&g_units.p[i]);
  g_units.n = g_index.n = g_births.n = g_groups.n = 0;
  jb_free(&U.parts);
  jb_free(&U.json);
  memset(&U, 0, sizeof U);
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
  { "activeUnits", l_activeUnits },
  { NULL, NULL },
};

void server_open(lua_State *L) {
  luaL_register(L, NULL, FUNCTIONS);
}

const NativeCollector SERVER_COLLECTORS[] = {
  { "units", unitsServer, 1 },
  { NULL, NULL, 0 },
};
