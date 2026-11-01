/* Client-side collectors, called by the scheduler in the hook state of a
   multiplayer client. The export API is the only data source a client has in
   someone else's game.

   LoGetWorldObjects (units and airdromes) returns a large fresh table, so
   it's called in the client's private state (private.h) and read there; the
   per-unit records, the diffing and the JSON stay in C, so no garbage lands
   in the hook state. The other calls return numbers, or (once per mission) a
   few small tables, and run in the hook state directly.

   The output matches the server side's groups and shapes: units, bullseyes,
   clock and airbases, so the relay and TRACS treat both sides alike. */

#define LUA_BUILD_AS_DLL
#include <windows.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include "lua.h"
#include "lauxlib.h"
#include "common.h"
#include "private.h"
#include "client.h"

/* An aircraft counts as airborne this high over the terrain, or faster than
   any taxi. */
#define AIRBORNE_AGL_M    30.0
#define AIRBORNE_SPEED_MS 40.0

/* LoGetWorldObjects Type.level1/level2 of a map airdrome (the airdromes list
   also holds unnamed runway objects, level2 18). */
#define AIRDROME_LEVEL1 5
#define AIRDROME_LEVEL2 13

static const char *COALITION_NAMES[] = { "neutral", "red", "blue" };

static char g_err[512];

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

static double roundTo(double x, double step) { return floor(x / step + 0.5) * step; }

static const char *coalitionName(int id) { return id >= 0 && id <= 2 ? COALITION_NAMES[id] : "neutral"; }

/* Field k of the table at idx as a number; 0 when it isn't one. */
static int tnum(lua_State *P, int idx, const char *k, double *out) {
  lua_getfield(P, idx, k);
  int ok = lua_type(P, -1) == LUA_TNUMBER;
  if (ok) *out = lua_tonumber(P, -1);
  lua_pop(P, 1);
  return ok;
}

static double tnumOr(lua_State *P, int idx, const char *k, double dflt) {
  double v;
  return tnum(P, idx, k, &v) ? v : dflt;
}

/* -1 nil, 0 false (or any non-true value), 1 true. */
static int tbool(lua_State *P, int idx, const char *k) {
  lua_getfield(P, idx, k);
  int r = lua_isnil(P, -1) ? -1 : lua_toboolean(P, -1) ? 1 : 0;
  lua_pop(P, 1);
  return r;
}

static char *tstrdup(lua_State *P, int idx, const char *k) {
  lua_getfield(P, idx, k);
  char *s = lua_type(P, -1) == LUA_TSTRING ? _strdup(lua_tostring(P, -1)) : NULL;
  lua_pop(P, 1);
  return s;
}

/* Pushes field k of the table at idx and returns its stack index if it's a
   table; otherwise pops it and returns 0. */
static int tsub(lua_State *P, int idx, const char *k) {
  lua_getfield(P, idx, k);
  if (lua_istable(P, -1)) return lua_gettop(P);
  lua_pop(P, 1);
  return 0;
}

/* A global function taking no arguments and returning a number, in L. */
static int callNum0(lua_State *L, const char *path, double *out) {
  push_path(L, path);
  if (!lua_isfunction(L, -1)) { lua_pop(L, 1); return 0; }
  if (lua_pcall(L, 0, 1, 0) != 0) { lua_pop(L, 1); return 0; }
  int ok = lua_type(L, -1) == LUA_TNUMBER;
  if (ok) *out = lua_tonumber(L, -1);
  lua_pop(L, 1);
  return ok;
}

static int objectExportAllowed(lua_State *L) {
  push_path(L, "Export.LoIsObjectExportAllowed");
  if (!lua_isfunction(L, -1)) { lua_pop(L, 1); return 0; }
  int ok = lua_pcall(L, 0, 1, 0) == 0 && lua_type(L, -1) == LUA_TBOOLEAN && lua_toboolean(L, -1);
  lua_pop(L, 1);
  return ok;
}

/* The mission table's `mission` field pushed onto L (DCS.getCurrentMission()
   .mission), returning its index, or 0 with nothing pushed. */
static int pushMission(lua_State *L) {
  push_path(L, "DCS.getCurrentMission");
  if (!lua_isfunction(L, -1) || lua_pcall(L, 0, 1, 0) != 0 || !lua_istable(L, -1)) { lua_pop(L, 1); return 0; }
  lua_getfield(L, -1, "mission");
  lua_remove(L, -2);
  if (lua_istable(L, -1)) return lua_gettop(L);
  lua_pop(L, 1);
  return 0;
}

/* LoGetWorldObjects(arg) in the private state, leaving its result on the
   private stack. 1 ok, -1 failed (error/fatal set). */
static int worldObjects(const char *arg, const char **error, int *fatal) {
  Side *s = &g_client;
  lua_pushcfunction(s->P, s->fns[C_GET_WORLD_OBJECTS].fn);
  if (arg) lua_pushstring(s->P, arg);
  int r = pcallPrivate(s, C_GET_WORLD_OBJECTS, arg ? 1 : 0, 1, NULL);
  if (r == 2) { *error = s->error; *fatal = 1; return -1; }
  if (r == 1) {
    _snprintf_s(g_err, sizeof g_err, _TRUNCATE, "%s: %s", s->fns[C_GET_WORLD_OBJECTS].path, lua_tostring(s->P, -1));
    clearPrivate(s);
    *error = g_err;
    return -1;
  }
  return 1;
}

static int clientUsable(void) { return g_client.ready && !g_client.faulted && g_client.P; }

/* ------------------------------------------------------------------ */
/* units_client                                                         */
/* ------------------------------------------------------------------ */

/* One unit as last sent, plus its previous position for velocity. name,
   type, groupName and category are set once, when the unit first appears. */
typedef struct {
  lua_Number id;
  char *name, *type, *groupName;
  int category, coalition, inAir, human, seen;
  double lat, lon, alt, agl, heading, pitch, vx, vy, vz;
  double px, py, pz, pt;
} Rec;

typedef struct { Rec *p; int n, cap; } RecList;

static RecList g_recs;   /* sorted by id */
static RecList g_fresh;  /* first seen this cycle */

static int pushRec(RecList *l, const Rec *r) {
  if (l->n == l->cap) {
    int cap = l->cap ? l->cap * 2 : 256;
    Rec *p = realloc(l->p, (size_t)cap * sizeof *p);
    if (!p) return 0;
    l->p = p;
    l->cap = cap;
  }
  l->p[l->n++] = *r;
  return 1;
}

static void freeRec(Rec *r) {
  free(r->name);
  free(r->type);
  free(r->groupName);
}

static int cmpRec(const void *a, const void *b) {
  lua_Number x = ((const Rec *)a)->id, y = ((const Rec *)b)->id;
  return x < y ? -1 : x > y;
}

static Rec *findRec(lua_Number id) {
  int lo = 0, hi = g_recs.n - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    lua_Number v = g_recs.p[mid].id;
    if (v == id) return &g_recs.p[mid];
    if (v < id) lo = mid + 1; else hi = mid - 1;
  }
  return NULL;
}

/* Mission-scoped cache for the clock. */
static struct {
  int have;
  double year, month, day, startTime;
} g_date;

void client_reset(void) {
  for (int i = 0; i < g_recs.n; i++) freeRec(&g_recs.p[i]);
  for (int i = 0; i < g_fresh.n; i++) freeRec(&g_fresh.p[i]);
  g_recs.n = g_fresh.n = 0;
  g_date.have = 0;
}

/* Export API Type.level1/level2 (Scripts/database/wsTypes.lua) -> the
   Group.Category numbers the server side sends; -1 for anything else. */
static int clientCategory(lua_State *P, int typeIdx) {
  double l1, l2;
  if (!typeIdx || !tnum(P, typeIdx, "level1", &l1)) return -1;
  if (!tnum(P, typeIdx, "level2", &l2)) l2 = -1;
  if (l1 == 1) {
    if (l2 == 1) return 0;
    if (l2 == 2) return 1;
  } else if (l1 == 2) return 2;
  else if (l1 == 3) return 3;
  return -1;
}

static void setNum(double *f, double v, int *dirty) {
  if (*f != v) { *f = v; *dirty = 1; }
}

static void setInt(int *f, int v, int *dirty) {
  if (*f != v) { *f = v; *dirty = 1; }
}

static void keyJson(JBuf *b, lua_Number id) {
  char key[32];
  _snprintf_s(key, sizeof key, _TRUNCATE, "%.14g", id);
  jb_str(b, key);
}

static void writeRec(JBuf *b, const Rec *r) {
  keyJson(b, r->id);
  jb_puts(b, ":{");
  if (r->name) { jb_puts(b, "\"name\":"); jb_str(b, r->name); jb_puts(b, ","); }
  if (r->type) { jb_puts(b, "\"type\":"); jb_str(b, r->type); jb_puts(b, ","); }
  if (r->groupName) { jb_puts(b, "\"groupName\":"); jb_str(b, r->groupName); jb_puts(b, ","); }
  jb_printf(b, "\"category\":%d,\"coalition\":%d,\"lat\":", r->category, r->coalition);
  jb_num(b, r->lat);
  jb_puts(b, ",\"lon\":"); jb_num(b, r->lon);
  jb_puts(b, ",\"alt\":"); jb_num(b, r->alt);
  jb_puts(b, ",\"agl\":"); jb_num(b, r->agl);
  jb_puts(b, ",\"heading\":"); jb_num(b, r->heading);
  jb_puts(b, ",\"pitch\":"); jb_num(b, r->pitch);
  jb_puts(b, ",\"vx\":"); jb_num(b, r->vx);
  jb_puts(b, ",\"vy\":"); jb_num(b, r->vy);
  jb_puts(b, ",\"vz\":"); jb_num(b, r->vz);
  jb_puts(b, r->inAir ? ",\"inAir\":true" : ",\"inAir\":false");
  jb_puts(b, r->human ? ",\"human\":true}" : ",\"human\":false}");
}

/* Ground height under (x, z) from the hook state's Export.LoGetAltitude at
   stack slot fn (0: none). */
static double groundHeight(lua_State *L, int fn, double x, double z) {
  if (!fn) return 0;
  lua_pushvalue(L, fn);
  lua_pushnumber(L, x);
  lua_pushnumber(L, z);
  double h = 0;
  if (lua_pcall(L, 2, 1, 0) == 0 && lua_type(L, -1) == LUA_TNUMBER) h = lua_tonumber(L, -1);
  lua_pop(L, 1);
  return h;
}

typedef struct {
  int n, changed;
  int full, first;
  double t;
} UnitsCycle;

/* One world object, the value at vIdx in P. */
static void unitFromObject(lua_State *L, int altFn, lua_State *P, lua_Number id, int vIdx, UnitsCycle *cy, JBuf *out) {
  int base = lua_gettop(P);
  int category = clientCategory(P, tsub(P, vIdx, "Type"));
  int flags = tsub(P, vIdx, "Flags");
  int isStatic = flags ? tbool(P, flags, "Static") == 1 : 0;
  int born = flags ? tbool(P, flags, "Born") : -1;
  int human = flags ? tbool(P, flags, "Human") == 1 : 0;
  int lla = tsub(P, vIdx, "LatLongAlt");
  int pos = tsub(P, vIdx, "Position");
  if (category < 0 || isStatic || born == 0 || !lla || !pos) { lua_settop(P, base); return; }

  cy->n++;
  double px = tnumOr(P, pos, "x", 0), py = tnumOr(P, pos, "y", 0), pz = tnumOr(P, pos, "z", 0);
  double lat = tnumOr(P, lla, "Lat", 0), lon = tnumOr(P, lla, "Long", 0), alt = tnumOr(P, lla, "Alt", 0);

  Rec fresh, *rec = findRec(id);
  int dirty = 0;
  double vx = 0, vy = 0, vz = 0;
  if (rec) {
    if (cy->t > rec->pt) {
      double dt = cy->t - rec->pt;
      vx = (px - rec->px) / dt; vy = (py - rec->py) / dt; vz = (pz - rec->pz) / dt;
    }
  } else {
    memset(&fresh, 0, sizeof fresh);
    fresh.id = id;
    fresh.name = tstrdup(P, vIdx, "UnitName");
    fresh.type = tstrdup(P, vIdx, "Name");
    fresh.groupName = tstrdup(P, vIdx, "GroupName");
    fresh.category = category;
    rec = &fresh;
    dirty = 1;
  }
  rec->px = px; rec->py = py; rec->pz = pz; rec->pt = cy->t;
  rec->seen = 1;

  double agl = alt - groundHeight(L, altFn, px, pz);
  double speed = sqrt(vx * vx + vy * vy + vz * vz);
  setInt(&rec->coalition, (int)tnumOr(P, vIdx, "CoalitionID", 0), &dirty);
  setNum(&rec->lat, roundTo(lat, 1e-6), &dirty);
  setNum(&rec->lon, roundTo(lon, 1e-6), &dirty);
  setNum(&rec->alt, roundTo(alt, 0.1), &dirty);
  setNum(&rec->agl, roundTo(agl, 0.1), &dirty);
  setNum(&rec->heading, roundTo(tnumOr(P, vIdx, "Heading", 0), 1e-3), &dirty);
  setNum(&rec->pitch, roundTo(tnumOr(P, vIdx, "Pitch", 0), 1e-3), &dirty);
  setNum(&rec->vx, roundTo(vx, 0.01), &dirty);
  setNum(&rec->vy, roundTo(vy, 0.01), &dirty);
  setNum(&rec->vz, roundTo(vz, 0.01), &dirty);
  setInt(&rec->inAir, rec->category <= 1 && (agl > AIRBORNE_AGL_M || speed > AIRBORNE_SPEED_MS), &dirty);
  setInt(&rec->human, human, &dirty);

  if (cy->full || dirty) {
    if (!cy->first) jb_puts(out, ",");
    cy->first = 0;
    writeRec(out, rec);
    cy->changed++;
  }
  if (rec == &fresh && !pushRec(&g_fresh, &fresh)) freeRec(&fresh);
  lua_settop(P, base);
}

/* Units from the export API, as the same units group and record shape as
   the server side, minus what the export API doesn't give (health, group
   id). Velocity comes from the position change since the last cycle. Only
   changed records are sent in a delta, plus "id":null for each unit gone. A
   server can deny object export (exportStatus reports that); every unit is
   then gone. */
static int unitsClient(lua_State *L, int full, JBuf *out, const char **kind, JBuf *extra, int *once,
                       const char **error, int *fatal) {
  (void)once;
  if (!clientUsable()) return 0;
  Side *s = &g_client;
  int top = lua_gettop(L);
  double t = 0;
  callNum0(L, "DCS.getModelTime", &t);
  push_path(L, "Export.LoGetAltitude");
  int altFn = lua_isfunction(L, -1) ? lua_gettop(L) : 0;

  double r0 = now_s(), kb0 = lua_gc(s->P, LUA_GCCOUNT, 0);
  int objects = 0;
  if (objectExportAllowed(L)) {
    if (worldObjects(NULL, error, fatal) < 0) { lua_settop(L, top); return -1; }
    objects = lua_istable(s->P, -1) ? lua_gettop(s->P) : 0;
  }
  double readMs = (now_s() - r0) * 1000, readKb = lua_gc(s->P, LUA_GCCOUNT, 0) - kb0;

  for (int i = 0; i < g_recs.n; i++) g_recs.p[i].seen = 0;
  g_fresh.n = 0;
  UnitsCycle cy = { 0, 0, full, 1, t };
  jb_puts(out, "{");
  if (objects) {
    lua_pushnil(s->P);
    while (lua_next(s->P, objects)) {
      if (lua_type(s->P, -2) == LUA_TNUMBER && lua_istable(s->P, -1)) {
        unitFromObject(L, altFn, s->P, lua_tonumber(s->P, -2), lua_gettop(s->P), &cy, out);
      }
      lua_pop(s->P, 1);
    }
  }
  clearPrivate(s);
  lua_settop(L, top);

  /* Units gone since the last cycle (a full cycle lists only what exists). */
  int removed = 0, keep = 0;
  for (int i = 0; i < g_recs.n; i++) {
    Rec *r = &g_recs.p[i];
    if (r->seen) { g_recs.p[keep++] = *r; continue; }
    if (!full) {
      if (!cy.first) jb_puts(out, ",");
      cy.first = 0;
      keyJson(out, r->id);
      jb_puts(out, ":null");
      removed++;
    }
    freeRec(r);
  }
  g_recs.n = keep;
  for (int i = 0; i < g_fresh.n; i++) {
    if (!pushRec(&g_recs, &g_fresh.p[i])) freeRec(&g_fresh.p[i]);
  }
  g_fresh.n = 0;
  qsort(g_recs.p, (size_t)g_recs.n, sizeof *g_recs.p, cmpRec);
  jb_puts(out, "}");

  *kind = full ? "full" : "delta";
  jb_printf(extra, ",\"units\":%d,\"changed\":%d,\"removed\":%d,\"readMs\":", cy.n, cy.changed, removed);
  jb_num(extra, readMs);
  jb_printf(extra, ",\"readKb\":%.0f", readKb);
  return 1;
}

/* ------------------------------------------------------------------ */
/* exportStatus, bullseyes, clock, airbases                             */
/* ------------------------------------------------------------------ */

/* Whether the DCS server allows object export; without it a client has no
   units to send, which TRACS's status bar explains. */
static int exportStatus(lua_State *L, int full, JBuf *out, const char **kind, JBuf *extra, int *once,
                        const char **error, int *fatal) {
  (void)full; (void)kind; (void)extra; (void)once; (void)error; (void)fatal;
  if (!clientUsable()) return 0;
  jb_puts(out, objectExportAllowed(L) ? "{\"objects\":true}" : "{\"objects\":false}");
  return 1;
}

/* Each coalition's bullseye as the mission file sets it, keyed by coalition
   id like the server side's. A script moving a bullseye during the mission
   isn't visible to a client; the mission's own one is what places ABM and
   AIC. Sent once per resync. */
static int bullseyesClient(lua_State *L, int full, JBuf *out, const char **kind, JBuf *extra, int *once,
                           const char **error, int *fatal) {
  (void)full; (void)kind; (void)extra; (void)error; (void)fatal;
  static const struct { const char *key; int id; } SIDES[] = { { "neutrals", 0 }, { "red", 1 }, { "blue", 2 } };
  if (!clientUsable()) return 0;
  int top = lua_gettop(L);
  int m = pushMission(L);
  int coal = m ? tsub(L, m, "coalition") : 0;
  int n = 0;
  jb_puts(out, "{");
  for (int i = 0; coal && i < 3; i++) {
    int side = tsub(L, coal, SIDES[i].key);
    int be = side ? tsub(L, side, "bullseye") : 0;
    double x, y;
    if (be && tnum(L, be, "x", &x) && tnum(L, be, "y", &y)) {
      /* Mission x is north, mission y the world z axis. */
      push_path(L, "Export.LoLoCoordinatesToGeoCoordinates");
      lua_pushnumber(L, x);
      lua_pushnumber(L, y);
      double lat, lon;
      if (lua_pcall(L, 2, 1, 0) == 0 && lua_istable(L, -1) && tnum(L, -1, "latitude", &lat) &&
          tnum(L, -1, "longitude", &lon)) {
        if (n++) jb_puts(out, ",");
        jb_printf(out, "\"%d\":{\"coalition\":", SIDES[i].id);
        jb_str(out, coalitionName(SIDES[i].id));
        jb_puts(out, ",\"latitude\":"); jb_num(out, roundTo(lat, 1e-6));
        jb_puts(out, ",\"longitude\":"); jb_num(out, roundTo(lon, 1e-6));
        jb_puts(out, "}");
      }
    }
    lua_settop(L, coal);
  }
  lua_settop(L, top);
  jb_puts(out, "}");
  if (!n) return 0;
  *once = 1;
  return 1;
}

/* Mission start date and the time of day, both theatre-local, in the server
   side's shape: absTime counts from midnight of the start date (start time
   plus model time) and passes 86400 after midnight. */
static int clockClient(lua_State *L, int full, JBuf *out, const char **kind, JBuf *extra, int *once,
                       const char **error, int *fatal) {
  (void)full; (void)kind; (void)extra; (void)once; (void)error; (void)fatal;
  if (!clientUsable()) return 0;
  if (!g_date.have) {
    int top = lua_gettop(L);
    int m = pushMission(L);
    int d = m ? tsub(L, m, "date") : 0;
    g_date.have = d && tnum(L, d, "Year", &g_date.year) && tnum(L, d, "Month", &g_date.month) &&
                  tnum(L, d, "Day", &g_date.day) && tnum(L, m, "start_time", &g_date.startTime);
    lua_settop(L, top);
    if (!g_date.have) return 0;
  }
  double t;
  if (!callNum0(L, "DCS.getModelTime", &t)) return 0;
  jb_printf(out, "{\"date\":{\"Year\":%.0f,\"Month\":%.0f,\"Day\":%.0f},\"absTime\":", g_date.year, g_date.month,
            g_date.day);
  jb_num(out, g_date.startTime + t);
  jb_puts(out, ",\"startTime\":");
  jb_num(out, g_date.startTime);
  jb_puts(out, "}");
  return 1;
}

/* The map's airdromes with their current owner, in the fields the server
   side sends (no carriers or FARPs: the export API lists those as units). */
static int airbasesClient(lua_State *L, int full, JBuf *out, const char **kind, JBuf *extra, int *once,
                          const char **error, int *fatal) {
  (void)full; (void)kind; (void)extra; (void)once;
  if (!clientUsable() || !objectExportAllowed(L)) return 0;
  Side *s = &g_client;
  if (worldObjects("airdromes", error, fatal) < 0) return -1;
  lua_State *P = s->P;
  int list = lua_istable(P, -1) ? lua_gettop(P) : 0;
  int n = 0;
  jb_puts(out, "{");
  if (list) {
    lua_pushnil(P);
    while (lua_next(P, list)) {
      int v = lua_gettop(P);
      if (lua_type(P, -2) == LUA_TNUMBER && lua_istable(P, v)) {
        lua_Number id = lua_tonumber(P, -2);
        int type = tsub(P, v, "Type");
        double l1 = 0, l2 = 0;
        int isAirdrome = type && tnum(P, type, "level1", &l1) && tnum(P, type, "level2", &l2) &&
                         l1 == AIRDROME_LEVEL1 && l2 == AIRDROME_LEVEL2;
        int lla = tsub(P, v, "LatLongAlt");
        double lat, lon;
        lua_getfield(P, v, "Name");
        if (isAirdrome && lla && lua_type(P, -1) == LUA_TSTRING && tnum(P, lla, "Lat", &lat) && tnum(P, lla, "Long", &lon)) {
          if (n++) jb_puts(out, ",");
          keyJson(out, id);
          jb_puts(out, ":{\"callsign\":");
          jb_str(out, lua_tostring(P, -1));
          jb_puts(out, ",\"coalition\":");
          jb_str(out, coalitionName((int)tnumOr(P, v, "CoalitionID", 0)));
          jb_puts(out, ",\"latitude\":"); jb_num(out, roundTo(lat, 1e-6));
          jb_puts(out, ",\"longitude\":"); jb_num(out, roundTo(lon, 1e-6));
          jb_puts(out, "}");
        }
      }
      lua_settop(P, v - 1);
    }
  }
  clearPrivate(s);
  jb_puts(out, "}");
  return n > 0;
}

const NativeCollector CLIENT_COLLECTORS[] = {
  { "units_client", unitsClient },
  { "exportStatus", exportStatus },
  { "bullseyes_client", bullseyesClient },
  { "clock_client", clockClient },
  { "airbases_client", airbasesClient },
  { NULL, NULL },
};
