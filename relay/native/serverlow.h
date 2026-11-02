/* Host-side low-rate collectors in C (bullseyes, airbases, clock, fog,
   weather, airfieldWeather), and the parts of server.c they share. */
#ifndef TRACS_SERVERLOW_H
#define TRACS_SERVERLOW_H

#include <stddef.h>
#include "lua.h"
#include "sched.h"
#include "private.h"

/* The scheduler's natives (listed in server.c's SERVER_COLLECTORS). */
int bullseyesServer(lua_State *L, NativeRun *r);
int airbasesServer(lua_State *L, NativeRun *r);
int clockServer(lua_State *L, NativeRun *r);
int fogServer(lua_State *L, NativeRun *r);
int weatherServer(lua_State *L, NativeRun *r);
int airfieldWeatherServer(lua_State *L, NativeRun *r);

/* Adds lowStep to the module table on top of L's stack. */
void serverlow_open(lua_State *L);
/* Forgets the mission's state; with the mission state (at init), also reads
   the Airbase.Category values. */
void serverlow_reset(lua_State *ML);

/* From server.c: private-state calls as its units and contacts make them
   (results SRV_*), the mission state a Lua-implemented DCS function runs
   in, and the hook side's step runner. */
enum { SRV_FAULT = -1, SRV_FAIL = 0, SRV_OK = 1 };
void srv_setMissionState(lua_State *L);
int srv_call(int fn, int nargs, int nres);
int srv_callObj(int fn, const Id *obj);
int srv_objNum(int fn, const Id *obj, double *out);
int srv_objBool(int fn, const Id *obj, int *out);
int srv_objStr(int fn, const Id *obj, char **out);
int srv_objId(int fn, const Id *obj, Id *out);
char srv_missionStep(lua_State *L, const char *code, char *err, size_t errLen);
int srv_stepResult(char status, NativeRun *r, char *err, size_t errLen, const char *what);

#endif
