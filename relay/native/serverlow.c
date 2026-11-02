/* Host-side low-rate collectors in C: bullseyes, airbases, clock, fog,
   weather and airfieldWeather, with the same output the Lua collectors had.

   Like units and contacts (server.c), each runs in the mission state:
   lowStep() there does the work, calling DCS's table-returning functions in
   the server's private state and reading the mission's own tables
   (env.mission) from C, which allocates nothing. The hook side sets which
   collector to run in C memory, calls lowStep with a constant
   net.dostring_in chunk and picks the JSON up from C memory.

   Airbases are passed to DCS as bare { id_ } tables, as units are. Airbase
   methods that return a scalar or an object may be Lua in some DCS version;
   they're then called in the mission state (server.c's luaOk route), which
   at these rates costs next to nothing. */

#define LUA_BUILD_AS_DLL
#include <windows.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
#include "common.h"
#include "private.h"
#include "serverlow.h"

#define LOW_STEP_CODE "return TRACS_DLL and TRACS_DLL.lowStep() or 'E'"

/* Airfields sampled per airfieldWeather step. */
#define WX_PER_STEP 10
/* FD winds-aloft levels sampled at an airfield: those at least this far
   above it. */
#define ALOFT_MIN_ABOVE_M (1500 * 0.3048)
#define FT_TO_M 0.3048
/* Airbases between private-state clears. */
#define CLEAR_EVERY 16
/* Nesting limit when encoding a mission table. */
#define ENCODE_MAX_DEPTH 16

static const int ALOFT_FT[] = { 3000, 6000, 9000, 12000, 18000, 24000, 30000, 34000, 39000 };
#define N_ALOFT ((int)(sizeof ALOFT_FT / sizeof ALOFT_FT[0]))

static const char *COALITION_NAMES[] = { "neutral", "red", "blue" };

enum { LOW_BULLSEYES, LOW_AIRBASES, LOW_CLOCK, LOW_FOG, LOW_WEATHER, LOW_AIRFIELD_WX };

/* What a lowStep body returns besides SRV_*: nothing to send this time, or
   a sliced cycle continuing next step. */
enum { LOW_NOTHING = 2, LOW_PENDING = 3 };

typedef struct { Id ab; int key; } WxBase;

static struct {
  int req, reqStart;   /* set by the hook side per step */
  JBuf json;
  int once;
  double kb0, kb1;
  char error[256];
} W;

/* airfieldWeather's cycle in progress. */
static struct {
  int active;
  WxBase *list;
  int n, cap, i, ships, count;
  JBuf parts;
  int airfields, staticAtm;  /* of the finished cycle, for the timing line */
} X;

/* Every airbase's object id, in world.getAirbases order (key = index). */
static struct {
  Id *p;
  int n, cap;
} g_ab;

static double g_catAirdrome = 0, g_catShip = 3;  /* Airbase.Category */

/* Cloud presets read from DCS's clouds.lua, by name, for the DLL's
   lifetime (the file only changes with a DCS update). json NULL: the
   preset couldn't be read. */
typedef struct { char *name; char *json; } PresetEntry;
static struct {
  PresetEntry *p;
  int n, cap;
} g_presets;

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

static lua_State *P(void) { return g_server.P; }

static double roundTo(double x, double step) { return floor(x / step + 0.5) * step; }

static void pushFn(int fn) { lua_pushcfunction(P(), g_server.fns[fn].fn); }

/* Whether fn can be called: a C function, or a Lua one taking the
   mission-state route. A missing optional one can't. */
static int have(int fn) { return g_server.fns[fn].fn != NULL || g_server.fns[fn].isLua; }

static int grow(void **p, int *cap, int need, size_t size) {
  if (need <= *cap) return 1;
  int c = *cap ? *cap : 32;
  while (c < need) c *= 2;
  void *q = realloc(*p, (size_t)c * size);
  if (!q) return 0;
  *p = q;
  *cap = c;
  return 1;
}

static int tnum(lua_State *L, int idx, const char *k, double *out) {
  lua_getfield(L, idx, k);
  int ok = lua_type(L, -1) == LUA_TNUMBER;
  if (ok) *out = lua_tonumber(L, -1);
  lua_pop(L, 1);
  return ok;
}

static void pushVec3(double x, double y, double z) {
  lua_createtable(P(), 0, 3);
  lua_pushnumber(P(), x); lua_setfield(P(), -2, "x");
  lua_pushnumber(P(), y); lua_setfield(P(), -2, "y");
  lua_pushnumber(P(), z); lua_setfield(P(), -2, "z");
}

/* A vec3 result at the top of the private stack, popped. */
static int popVec3(double *x, double *y, double *z) {
  int ok = lua_istable(P(), -1) && tnum(P(), -1, "x", x) && tnum(P(), -1, "y", y) && tnum(P(), -1, "z", z);
  lua_pop(P(), 1);
  return ok;
}

/* fn(args already pushed above base) returning nres values; on SRV_FAIL the
   stack is put back to base. On SRV_FAULT the private state isn't touched
   again. */
static int callAt(int fn, int base, int nargs, int nres) {
  int r = srv_call(fn, nargs, nres);
  if (r == SRV_FAIL) lua_settop(P(), base);
  return r;
}

static int loToLL(double x, double y, double z, double *lat, double *lon) {
  int base = lua_gettop(P());
  pushFn(S_LO_TO_LL);
  pushVec3(x, y, z);
  int r = callAt(S_LO_TO_LL, base, 1, 3);
  if (r != SRV_OK) return r;
  int ok = lua_isnumber(P(), -3) && lua_isnumber(P(), -2);
  if (ok) { *lat = lua_tonumber(P(), -3); *lon = lua_tonumber(P(), -2); }
  lua_settop(P(), base);
  return ok ? SRV_OK : SRV_FAIL;
}

static int abPoint(const Id *ab, double *x, double *y, double *z) {
  int r = srv_callObj(S_AB_GET_POINT, ab);
  if (r != SRV_OK) return r;
  return popVec3(x, y, z) ? SRV_OK : SRV_FAIL;
}

static int groundHeight(double x, double z, double *out) {
  int base = lua_gettop(P());
  pushFn(S_GET_HEIGHT);
  lua_createtable(P(), 0, 2);
  lua_pushnumber(P(), x); lua_setfield(P(), -2, "x");
  lua_pushnumber(P(), z); lua_setfield(P(), -2, "y");
  int r = callAt(S_GET_HEIGHT, base, 1, 1);
  if (r != SRV_OK) return r;
  int ok = lua_isnumber(P(), -1);
  if (ok) *out = lua_tonumber(P(), -1);
  lua_settop(P(), base);
  return ok ? SRV_OK : SRV_FAIL;
}

/* Temperature (K), pressure (Pa) and wind (m/s on the map's x/z axes) at a
   point; pressure is only read when p is given. */
static int sampleAt(double x, double y, double z, double *t, double *p, double *wx, double *wz) {
  int base = lua_gettop(P());
  pushFn(S_GET_TEMP_PRESSURE);
  pushVec3(x, y, z);
  int r = callAt(S_GET_TEMP_PRESSURE, base, 1, 2);
  if (r != SRV_OK) return r;
  int ok = lua_isnumber(P(), -2) && lua_isnumber(P(), -1);
  if (ok) {
    *t = lua_tonumber(P(), -2);
    if (p) *p = lua_tonumber(P(), -1);
  }
  lua_settop(P(), base);
  if (!ok) return SRV_FAIL;

  pushFn(S_GET_WIND);
  pushVec3(x, y, z);
  if ((r = callAt(S_GET_WIND, base, 1, 1)) != SRV_OK) return r;
  double wy;
  return popVec3(wx, &wy, wz) ? SRV_OK : SRV_FAIL;
}

/* The airbase's callsign and, for one that is a unit (a ship), the unit's
   id. A Lua error from either just leaves the field out. */
static int abNames(const Id *ab, char **callsign, double *unitId, int *haveUnit) {
  *haveUnit = 0;
  int r = srv_objStr(S_AB_GET_CALLSIGN, ab, callsign);
  if (r == SRV_FAULT) return r;
  Id unit;
  r = srv_objId(S_AB_GET_UNIT, ab, &unit);
  if (r == SRV_FAULT) { free(*callsign); *callsign = NULL; return r; }
  if (r == SRV_OK) {
    r = srv_objNum(S_GET_ID, &unit, unitId);
    if (r == SRV_FAULT) { free(*callsign); *callsign = NULL; return r; }
    *haveUnit = r == SRV_OK;
  }
  return SRV_OK;
}

static void numField(JBuf *b, const char *k, double v) {
  jb_printf(b, ",\"%s\":", k);
  jb_num(b, v);
}

/* Copies every airbase's object id out of world.getAirbases into g_ab and
   clears the private state. */
static int listAirbases(void) {
  int base = lua_gettop(P());
  g_ab.n = 0;
  pushFn(S_GET_AIRBASES);
  int r = callAt(S_GET_AIRBASES, base, 0, 1);
  if (r != SRV_OK) {
    if (r == SRV_FAIL) _snprintf_s(W.error, sizeof W.error, _TRUNCATE, "world.getAirbases failed");
    return r;
  }
  if (lua_istable(P(), -1)) {
    int n = (int)lua_objlen(P(), -1);
    if (grow((void **)&g_ab.p, &g_ab.cap, n, sizeof *g_ab.p)) {
      for (int i = 1; i <= n; i++) {
        lua_rawgeti(P(), -1, i);
        Id id = { 0 };
        if (!lua_istable(P(), -1) || !readId(P(), -1, &id)) id.type = LUA_TNIL;
        g_ab.p[g_ab.n++] = id;
        lua_pop(P(), 1);
      }
    }
  }
  clearPrivate(&g_server);
  return SRV_OK;
}

/* ------------------------------------------------------------------ */
/* A mission table as JSON                                              */
/* ------------------------------------------------------------------ */

/* Whether the table at idx is a list (keys 1..n, n > 0) or empty; *n is
   its length then. */
static int isList(lua_State *L, int idx, int *n) {
  int count = 0;
  double maxKey = 0;
  int list = 1;
  lua_pushnil(L);
  while (lua_next(L, idx)) {
    lua_pop(L, 1);
    count++;
    if (lua_type(L, -1) != LUA_TNUMBER) { list = 0; continue; }
    double k = lua_tonumber(L, -1);
    if (k < 1 || k != floor(k)) list = 0;
    else if (k > maxKey) maxKey = k;
  }
  *n = count;
  return list && maxKey == count;
}

static int encodable(int t) {
  return t == LUA_TNIL || t == LUA_TBOOLEAN || t == LUA_TNUMBER || t == LUA_TSTRING || t == LUA_TTABLE;
}

/* The value at idx as JSON, walking tables without allocating anything in
   L. An empty table is [] (as the Lua encoder wrote it); functions and
   other non-data values are left out of objects and null in lists. Keys
   that are neither strings nor numbers are left out. */
static void encodeValue(lua_State *L, int idx, JBuf *b, int depth) {
  if (idx < 0) idx = lua_gettop(L) + idx + 1;
  switch (lua_type(L, idx)) {
    case LUA_TBOOLEAN: jb_puts(b, lua_toboolean(L, idx) ? "true" : "false"); return;
    case LUA_TNUMBER: jb_num(b, lua_tonumber(L, idx)); return;
    case LUA_TSTRING: {
      size_t len;
      const char *s = lua_tolstring(L, idx, &len);
      jb_lstr(b, s, len);
      return;
    }
    case LUA_TTABLE: break;
    default: jb_puts(b, "null"); return;
  }
  if (depth >= ENCODE_MAX_DEPTH || !lua_checkstack(L, 4)) { jb_puts(b, "null"); return; }
  int n;
  if (isList(L, idx, &n)) {
    jb_puts(b, "[");
    for (int i = 1; i <= n; i++) {
      if (i > 1) jb_puts(b, ",");
      lua_rawgeti(L, idx, i);
      encodeValue(L, -1, b, depth + 1);
      lua_pop(L, 1);
    }
    jb_puts(b, "]");
    return;
  }
  jb_puts(b, "{");
  int first = 1;
  lua_pushnil(L);
  while (lua_next(L, idx)) {
    int kt = lua_type(L, -2);
    if ((kt == LUA_TSTRING || kt == LUA_TNUMBER) && encodable(lua_type(L, -1))) {
      if (!first) jb_puts(b, ",");
      first = 0;
      if (kt == LUA_TSTRING) {
        size_t len;
        /* A string key: lua_tolstring leaves it as it is, so lua_next
           still works. */
        const char *k = lua_tolstring(L, -2, &len);
        jb_lstr(b, k, len);
      } else {
        char k[32];
        _snprintf_s(k, sizeof k, _TRUNCATE, "%.14g", lua_tonumber(L, -2));
        jb_str(b, k);
      }
      jb_puts(b, ":");
      encodeValue(L, -1, b, depth + 1);
    }
    lua_pop(L, 1);
  }
  jb_puts(b, "}");
}

/* ------------------------------------------------------------------ */
/* bullseyes, airbases, clock, fog                                      */
/* ------------------------------------------------------------------ */

/* Each coalition's bullseye, keyed by coalition id. */
static int lowBullseyes(void) {
  JBuf *b = &W.json;
  int n = 0;
  jb_puts(b, "{");
  for (int side = 0; side <= 2; side++) {
    int base = lua_gettop(P());
    pushFn(S_GET_MAIN_REF_POINT);
    lua_pushnumber(P(), side);
    int r = callAt(S_GET_MAIN_REF_POINT, base, 1, 1);
    if (r == SRV_FAULT) return r;
    double x, y, z, lat, lon;
    if (r != SRV_OK || !popVec3(&x, &y, &z)) { lua_settop(P(), base); continue; }
    if ((r = loToLL(x, y, z, &lat, &lon)) == SRV_FAULT) return r;
    if (r != SRV_OK) continue;
    if (n++) jb_puts(b, ",");
    jb_printf(b, "\"%d\":{\"coalition\":", side);
    jb_str(b, COALITION_NAMES[side]);
    numField(b, "latitude", roundTo(lat, 1e-6));
    numField(b, "longitude", roundTo(lon, 1e-6));
    jb_puts(b, "}");
  }
  jb_puts(b, "}");
  return SRV_OK;
}

/* Every airfield, FARP and carrier with its current owner, in the fields
   Olympus sends, keyed by world.getAirbases index; unitId only for an
   airbase that is a unit (a ship). One that can't be read is left out. */
static int lowAirbases(void) {
  int r = listAirbases();
  if (r != SRV_OK) return r;
  JBuf *b = &W.json;
  int n = 0;
  jb_puts(b, "{");
  for (int i = 0; i < g_ab.n; i++) {
    const Id *ab = &g_ab.p[i];
    if (ab->type == LUA_TNIL) continue;
    if (i % CLEAR_EVERY == CLEAR_EVERY - 1) clearPrivate(&g_server);
    double x, y, z, lat, lon, side = 0, unitId = 0;
    if ((r = abPoint(ab, &x, &y, &z)) == SRV_FAULT) return r;
    if (r != SRV_OK) continue;
    if ((r = loToLL(x, y, z, &lat, &lon)) == SRV_FAULT) return r;
    if (r != SRV_OK) continue;
    if ((r = srv_objNum(S_AB_GET_COALITION, ab, &side)) == SRV_FAULT) return r;
    char *callsign = NULL;
    int haveUnit;
    if ((r = abNames(ab, &callsign, &unitId, &haveUnit)) == SRV_FAULT) return r;
    int s = (int)side;
    if (n++) jb_puts(b, ",");
    jb_printf(b, "\"%d\":{", i + 1);
    if (callsign) {
      jb_puts(b, "\"callsign\":");
      jb_str(b, callsign);
      jb_puts(b, ",");
    }
    jb_puts(b, "\"coalition\":");
    jb_str(b, s >= 0 && s <= 2 ? COALITION_NAMES[s] : "neutral");
    numField(b, "latitude", roundTo(lat, 1e-6));
    numField(b, "longitude", roundTo(lon, 1e-6));
    if (haveUnit) numField(b, "unitId", unitId);
    jb_puts(b, "}");
    free(callsign);
  }
  jb_puts(b, "}");
  return SRV_OK;
}

/* Mission start date and the time of day, both theatre-local. absTime
   counts from midnight of the start date and passes 86400 after midnight,
   so the backend rolls the date forward from it. */
static int lowClock(lua_State *ML) {
  double t;
  int base = lua_gettop(P());
  pushFn(S_GET_ABS_TIME);
  int r = callAt(S_GET_ABS_TIME, base, 0, 1);
  if (r != SRV_OK) {
    if (r == SRV_FAIL) _snprintf_s(W.error, sizeof W.error, _TRUNCATE, "timer.getAbsTime failed");
    return r;
  }
  t = lua_tonumber(P(), -1);
  lua_settop(P(), base);

  JBuf *b = &W.json;
  int top = lua_gettop(ML);
  push_path(ML, "env.mission");
  int m = lua_istable(ML, -1) ? lua_gettop(ML) : 0;
  jb_puts(b, "{");
  if (m) {
    lua_getfield(ML, m, "date");
    if (lua_istable(ML, -1)) {
      jb_puts(b, "\"date\":");
      encodeValue(ML, -1, b, 0);
      jb_puts(b, ",");
    }
    lua_pop(ML, 1);
  }
  jb_puts(b, "\"absTime\":");
  jb_num(b, t);
  double start;
  if (m && tnum(ML, m, "start_time", &start)) numField(b, "startTime", start);
  jb_puts(b, "}");
  lua_settop(ML, top);
  return SRV_OK;
}

/* Fog as it is now (it can thicken and thin during a mission): visibility
   distance and layer thickness, metres. A field this DCS has no call for is
   left out. */
static int lowFog(void) {
  static const struct { int fn; const char *key; } FIELDS[] = {
    { S_FOG_VISIBILITY, "visibility" }, { S_FOG_THICKNESS, "thickness" },
  };
  JBuf *b = &W.json;
  int n = 0;
  jb_puts(b, "{");
  for (int i = 0; i < 2; i++) {
    if (!have(FIELDS[i].fn)) continue;
    int base = lua_gettop(P());
    pushFn(FIELDS[i].fn);
    int r = callAt(FIELDS[i].fn, base, 0, 1);
    if (r == SRV_FAULT) return r;
    if (r == SRV_OK && lua_isnumber(P(), -1)) {
      jb_printf(b, "%s\"%s\":", n++ ? "," : "", FIELDS[i].key);
      jb_num(b, lua_tonumber(P(), -1));
    }
    lua_settop(P(), base);
  }
  jb_puts(b, "}");
  return SRV_OK;
}

/* ------------------------------------------------------------------ */
/* weather                                                              */
/* ------------------------------------------------------------------ */

static int l_identity(lua_State *L) {
  lua_settop(L, 1);
  return 1;
}

static void openLib(lua_State *T, lua_CFunction open) {
  lua_pushcfunction(T, open);
  lua_call(T, 0, 0);
}

/* A cloud preset's layers and precipitation as DCS defines them
   (Config/Effects/clouds.lua in the install, DCS's working directory):
   layer altitudes in metres for the preset's default base, coverage 0..1+.
   Read from the file, so it follows DCS updates. The file only builds
   tables; it runs in a throwaway Lua state with just the globals it uses.
   Returns a malloc'd JSON object, or NULL. */
static char *readCloudPreset(const char *name) {
  char dir[MAX_PATH], path[MAX_PATH + 64];
  DWORD n = GetCurrentDirectoryA(sizeof dir, dir);
  if (n == 0 || n >= sizeof dir) return NULL;
  _snprintf_s(path, sizeof path, _TRUNCATE, "%s\\Config\\Effects\\clouds.lua", dir);

  lua_State *T = luaL_newstate();
  if (!T) return NULL;
  char *result = NULL;
  openLib(T, luaopen_base);
  openLib(T, luaopen_table);
  openLib(T, luaopen_string);
  openLib(T, luaopen_math);
  if (luaL_loadfile(T, path) != 0) goto done;
  int chunk = lua_gettop(T);

  lua_newtable(T);
  int env = lua_gettop(T);
  lua_pushcfunction(T, l_identity);
  lua_setfield(T, env, "_");
  static const char *GLOBALS[] = { "pairs", "ipairs", "next", "type", "tostring", "setmetatable",
                                   "getmetatable", "math", "string", "table" };
  for (int i = 0; i < (int)(sizeof GLOBALS / sizeof GLOBALS[0]); i++) {
    lua_getglobal(T, GLOBALS[i]);
    lua_setfield(T, env, GLOBALS[i]);
  }
  lua_pushvalue(T, env);
  lua_setfenv(T, chunk);
  lua_pushvalue(T, chunk);
  if (lua_pcall(T, 0, 0, 0) != 0) goto done;

  lua_getfield(T, env, "clouds");
  if (!lua_istable(T, -1)) goto done;
  lua_getfield(T, -1, "presets");
  if (!lua_istable(T, -1)) goto done;
  lua_getfield(T, -1, name);
  if (!lua_istable(T, -1)) goto done;
  int p = lua_gettop(T);

  JBuf b;
  jb_init(&b);
  jb_puts(&b, "{");
  double v;
  if (tnum(T, p, "precipitationPower", &v)) {
    jb_puts(&b, "\"precipitationPower\":");
    jb_num(&b, v);
    jb_puts(&b, ",");
  }
  jb_puts(&b, "\"layers\":[");
  lua_getfield(T, p, "layers");
  if (lua_istable(T, -1)) {
    int layers = lua_gettop(T);
    int nl = (int)lua_objlen(T, layers);
    for (int i = 1; i <= nl; i++) {
      lua_rawgeti(T, layers, i);
      if (i > 1) jb_puts(&b, ",");
      jb_puts(&b, "{");
      static const char *KEYS[] = { "altitudeMin", "altitudeMax", "coverage" };
      int nk = 0;
      for (int k = 0; k < 3; k++) {
        if (lua_istable(T, -1) && tnum(T, -1, KEYS[k], &v)) {
          jb_printf(&b, "%s\"%s\":", nk++ ? "," : "", KEYS[k]);
          jb_num(&b, v);
        }
      }
      jb_puts(&b, "}");
      lua_pop(T, 1);
    }
  }
  jb_puts(&b, "]}");
  if (!b.oom) result = _strdup(b.p);
  jb_free(&b);

done:
  lua_close(T);
  return result;
}

/* The cached preset (read once per name), or NULL. */
static const char *cloudPreset(lua_State *ML, const char *name) {
  for (int i = 0; i < g_presets.n; i++) {
    if (strcmp(g_presets.p[i].name, name) == 0) return g_presets.p[i].json;
  }
  char *json = readCloudPreset(name);
  if (!json) dcs_log(ML, LOG_WARNING, "cloud preset %s unreadable from Config/Effects/clouds.lua", name);
  char *copy = _strdup(name);
  if (copy && grow((void **)&g_presets.p, &g_presets.cap, g_presets.n + 1, sizeof *g_presets.p)) {
    g_presets.p[g_presets.n].name = copy;
    g_presets.p[g_presets.n].json = json;
    g_presets.n++;
  } else {
    free(copy);
    free(json);
    return NULL;
  }
  return json;
}

/* The mission's weather table as the mission editor wrote it (QNH in mmHg,
   visibility, clouds, fog, dust, the three wind layers...) plus its cloud
   preset's layers. It never changes during a mission, so it's sent once per
   resync. */
static int lowWeather(lua_State *ML) {
  int top = lua_gettop(ML);
  push_path(ML, "env.mission");
  if (lua_istable(ML, -1)) lua_getfield(ML, -1, "weather");
  if (!lua_istable(ML, -1)) { lua_settop(ML, top); return LOW_NOTHING; }
  int w = lua_gettop(ML);
  JBuf *b = &W.json;
  jb_puts(b, "{\"mission\":");
  encodeValue(ML, w, b, 0);
  lua_getfield(ML, w, "clouds");
  if (lua_istable(ML, -1)) {
    lua_getfield(ML, -1, "preset");
    if (lua_type(ML, -1) == LUA_TSTRING) {
      const char *preset = cloudPreset(ML, lua_tostring(ML, -1));
      if (preset) {
        jb_puts(b, ",\"cloudPreset\":");
        jb_puts(b, preset);
      }
    }
  }
  jb_puts(b, "}");
  lua_settop(ML, top);
  W.once = 1;
  return SRV_OK;
}

/* ------------------------------------------------------------------ */
/* airfieldWeather                                                      */
/* ------------------------------------------------------------------ */

/* 0 when the mission's atmosphere is static (fixed for the whole mission),
   1 when dynamic (the mission editor's regimenStandard/regimenDynamic); a
   mission without the field counts as dynamic. */
static int atmosphereType(lua_State *ML) {
  int top = lua_gettop(ML);
  push_path(ML, "env.mission");
  if (lua_istable(ML, -1)) lua_getfield(ML, -1, "weather");
  double t = 1;
  int isStatic = lua_istable(ML, -1) && tnum(ML, -1, "atmosphere_type", &t) && t == 0;
  lua_settop(ML, top);
  return isStatic ? 0 : 1;
}

/* The airdromes and ships to sample (FARPs and helipads aren't), by their
   description's category. */
static int startAirfieldWx(void) {
  X.active = 1;
  X.n = X.i = X.ships = X.count = 0;
  jb_free(&X.parts);
  int r = listAirbases();
  if (r != SRV_OK) return r;
  for (int i = 0; i < g_ab.n; i++) {
    const Id *ab = &g_ab.p[i];
    if (ab->type == LUA_TNIL) continue;
    if (i % CLEAR_EVERY == CLEAR_EVERY - 1) clearPrivate(&g_server);
    r = srv_callObj(S_AB_GET_DESC, ab);
    if (r == SRV_FAULT) return r;
    if (r != SRV_OK) continue;
    double cat = -1;
    if (lua_istable(P(), -1)) tnum(P(), -1, "category", &cat);
    lua_pop(P(), 1);
    if (cat != g_catAirdrome && cat != g_catShip) continue;
    if (!grow((void **)&X.list, &X.cap, X.n + 1, sizeof *X.list)) break;
    X.list[X.n].ab = *ab;
    X.list[X.n].key = i + 1;
    X.n++;
    if (cat == g_catShip) X.ships++;
  }
  clearPrivate(&g_server);
  return SRV_OK;
}

/* Live weather at one airfield: pressure and temperature at the surface,
   wind 10 m above it, and wind and temperature at the FD winds-aloft levels
   at least 1500 ft above the field. Values go out raw (K, Pa, wind as the
   air's velocity in m/s on the map's x north / z east axes); the backend
   turns them into QNH and from-directions. One that can't be read is left
   out. */
static int sampleAirfield(const WxBase *e) {
  int exists = 0;
  int r = srv_objBool(S_AB_IS_EXIST, &e->ab, &exists);
  if (r != SRV_OK || !exists) return r == SRV_FAULT ? r : SRV_OK;
  double x, y, z, elev, t, p, wx, wz, lat, lon, unitId = 0;
  if ((r = abPoint(&e->ab, &x, &y, &z)) != SRV_OK) return r == SRV_FAULT ? r : SRV_OK;
  if ((r = groundHeight(x, z, &elev)) != SRV_OK) return r == SRV_FAULT ? r : SRV_OK;
  if ((r = sampleAt(x, elev, z, &t, &p, &wx, &wz)) != SRV_OK) return r == SRV_FAULT ? r : SRV_OK;
  /* The surface wind is read 10 m up. */
  double t10;
  if ((r = sampleAt(x, elev + 10, z, &t10, NULL, &wx, &wz)) != SRV_OK) return r == SRV_FAULT ? r : SRV_OK;
  if ((r = loToLL(x, y, z, &lat, &lon)) != SRV_OK) return r == SRV_FAULT ? r : SRV_OK;
  char *callsign = NULL;
  int haveUnit;
  if ((r = abNames(&e->ab, &callsign, &unitId, &haveUnit)) == SRV_FAULT) return r;

  JBuf rec;
  jb_init(&rec);
  jb_printf(&rec, "\"%d\":{\"callsign\":", e->key);
  if (callsign) jb_str(&rec, callsign); else jb_puts(&rec, "null");
  free(callsign);
  numField(&rec, "latitude", roundTo(lat, 1e-6));
  numField(&rec, "longitude", roundTo(lon, 1e-6));
  numField(&rec, "elevation", roundTo(elev, 0.1));
  numField(&rec, "t", roundTo(t, 0.01));
  numField(&rec, "p", roundTo(p, 1));
  numField(&rec, "wx", roundTo(wx, 0.01));
  numField(&rec, "wz", roundTo(wz, 0.01));
  if (haveUnit) numField(&rec, "unitId", unitId);
  jb_puts(&rec, ",\"aloft\":[");
  int na = 0;
  for (int i = 0; i < N_ALOFT; i++) {
    double alt = ALOFT_FT[i] * FT_TO_M, at, awx, awz;
    if (alt < elev + ALOFT_MIN_ABOVE_M) continue;
    r = sampleAt(x, alt, z, &at, NULL, &awx, &awz);
    if (r == SRV_FAULT) { jb_free(&rec); return r; }
    if (r != SRV_OK) continue;
    jb_printf(&rec, "%s{\"ft\":%d", na++ ? "," : "", ALOFT_FT[i]);
    numField(&rec, "t", roundTo(at, 0.01));
    numField(&rec, "wx", roundTo(awx, 0.01));
    numField(&rec, "wz", roundTo(awz, 0.01));
    jb_puts(&rec, "}");
  }
  jb_puts(&rec, "]}");
  if (!rec.oom) {
    if (X.count++) jb_puts(&X.parts, ",");
    jb_put(&X.parts, rec.p, rec.len);
  }
  jb_free(&rec);
  return SRV_OK;
}

/* One slice: WX_PER_STEP airfields, then the full map once all are done. A
   static atmosphere is fixed for the whole mission, so it's then sampled
   once per resync. */
static int lowAirfieldWx(lua_State *ML) {
  int r;
  if ((W.reqStart || !X.active) && (r = startAirfieldWx()) != SRV_OK) {
    X.active = 0;
    return r;
  }
  int last = X.i + WX_PER_STEP < X.n ? X.i + WX_PER_STEP : X.n;
  for (; X.i < last; X.i++) {
    if ((r = sampleAirfield(&X.list[X.i])) == SRV_FAULT) { X.active = 0; return r; }
    clearPrivate(&g_server);
  }
  if (X.i < X.n) return LOW_PENDING;

  X.active = 0;
  X.airfields = X.count;
  X.staticAtm = atmosphereType(ML) == 0;
  jb_puts(&W.json, "{");
  if (X.parts.len) jb_put(&W.json, X.parts.p, X.parts.len);
  jb_puts(&W.json, "}");
  if (X.parts.oom) W.json.oom = 1;
  jb_free(&X.parts);
  W.once = X.staticAtm;
  return SRV_OK;
}

/* ------------------------------------------------------------------ */
/* The two halves                                                       */
/* ------------------------------------------------------------------ */

/* lowStep() in the mission state: runs the collector the hook side asked
   for. Returns "F" when its JSON is ready, "N" when there's nothing to
   send, "P" while airfieldWeather's cycle continues, "X" after a caught
   exception (report in g_server.error), "E" on any other failure
   (W.error). */
static int l_lowStep(lua_State *L) {
  W.kb0 = lua_gc(L, LUA_GCCOUNT, 0);
  const char *status = "E";
  if (!g_server.ready || g_server.faulted || !g_server.P) {
    _snprintf_s(W.error, sizeof W.error, _TRUNCATE, "the DLL is not ready in the mission environment");
    goto out;
  }
  srv_setMissionState(L);
  jb_free(&W.json);
  int r;
  switch (W.req) {
    case LOW_BULLSEYES: r = lowBullseyes(); break;
    case LOW_AIRBASES: r = lowAirbases(); break;
    case LOW_CLOCK: r = lowClock(L); break;
    case LOW_FOG: r = lowFog(); break;
    case LOW_WEATHER: r = lowWeather(L); break;
    case LOW_AIRFIELD_WX: r = lowAirfieldWx(L); break;
    default: r = SRV_FAIL; _snprintf_s(W.error, sizeof W.error, _TRUNCATE, "unknown low-rate collector"); break;
  }
  srv_setMissionState(NULL);
  if (r == SRV_FAULT) { status = "X"; goto out; }
  clearPrivate(&g_server);
  status = r == SRV_OK ? "F" : r == LOW_NOTHING ? "N" : r == LOW_PENDING ? "P" : "E";
  if (r == SRV_FAIL && !W.error[0]) _snprintf_s(W.error, sizeof W.error, _TRUNCATE, "a DCS call failed");
out:
  W.kb1 = lua_gc(L, LUA_GCCOUNT, 0);
  lua_pushstring(L, status);
  return 1;
}

/* The hook side of every low-rate collector. */
static int lowRun(lua_State *L, NativeRun *r, int which, const char *what) {
  if (!g_server.ready || g_server.faulted) return 0;
  W.error[0] = 0;
  W.req = which;
  W.reqStart = r->start;
  W.once = 0;
  char status = srv_missionStep(L, LOW_STEP_CODE, W.error, sizeof W.error);
  r->srvKb0 = W.kb0;
  r->srvKb1 = W.kb1;
  if (status == 'N') return 0;
  if (status == 'F') {
    if (W.json.oom) {
      jb_free(&W.json);
      r->error = "out of memory building the JSON";
      return -1;
    }
    jb_put(r->out, W.json.p, W.json.len);
    jb_free(&W.json);
    r->once = W.once;
  }
  return srv_stepResult(status, r, W.error, sizeof W.error, what);
}

/* Bullseyes rarely move (only when a script sets one), so a slow rate. */
int bullseyesServer(lua_State *L, NativeRun *r) { return lowRun(L, r, LOW_BULLSEYES, "bullseyes"); }
/* Ownership changes only on capture. */
int airbasesServer(lua_State *L, NativeRun *r) { return lowRun(L, r, LOW_AIRBASES, "airbases"); }
/* TRACS runs the clock locally between updates, so this only corrects
   drift, e.g. after a pause. */
int clockServer(lua_State *L, NativeRun *r) { return lowRun(L, r, LOW_CLOCK, "clock"); }
/* Fog can change during a mission (auto and manual fog animate). */
int fogServer(lua_State *L, NativeRun *r) { return lowRun(L, r, LOW_FOG, "fog"); }
int weatherServer(lua_State *L, NativeRun *r) { return lowRun(L, r, LOW_WEATHER, "weather"); }

int airfieldWeatherServer(lua_State *L, NativeRun *r) {
  int res = lowRun(L, r, LOW_AIRFIELD_WX, "airfieldWeather");
  if (res == 1) {
    jb_printf(r->extra, ",\"airfields\":%d,\"ships\":%d,\"static\":%s", X.airfields, X.ships,
              X.staticAtm ? "true" : "false");
  }
  return res;
}

static const luaL_Reg FUNCTIONS[] = {
  { "lowStep", l_lowStep },
  { NULL, NULL },
};

void serverlow_open(lua_State *L) {
  luaL_register(L, NULL, FUNCTIONS);
}

void serverlow_reset(lua_State *ML) {
  jb_free(&W.json);
  jb_free(&X.parts);
  free(X.list);
  memset(&W, 0, sizeof W);
  memset(&X, 0, sizeof X);
  g_ab.n = 0;
  if (!ML) return;
  push_path(ML, "Airbase.Category");
  if (lua_istable(ML, -1)) {
    tnum(ML, -1, "AIRDROME", &g_catAirdrome);
    tnum(ML, -1, "SHIP", &g_catShip);
  }
  lua_pop(ML, 1);
}
