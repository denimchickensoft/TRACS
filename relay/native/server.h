/* Server-side (host) collectors in C: the mission-state half that calls DCS
   in the private state, and the hook-state half the scheduler runs. */
#ifndef TRACS_SERVER_H
#define TRACS_SERVER_H

#include "sched.h"
#include "private.h"

/* units, contacts and the low-rate collectors (serverlow.c); ends with
   { NULL, NULL, 0 }. */
extern const NativeCollector SERVER_COLLECTORS[];

/* Adds unitsStep/onBirth/contactsStep/lowStep to the module table on top of L's
   stack (they're called in the mission state). */
void server_open(lua_State *L);

/* Forgets the mission's units and contacts. With the mission state (at init), also reads
   the constants the collectors need from it. */
void server_reset(lua_State *L);

/* DCS object classes a rebuilt object can carry the methods of. */
enum { OBJ_UNIT, OBJ_GROUP, OBJ_AIRBASE, OBJ_CLASSES };

/* Pushes onto the mission state ML an object for id that has its class's
   methods (cls: OBJ_*), for a Lua-implemented DCS function. Needs
   server_reset(ML) first. */
void server_pushObject(lua_State *ML, const Id *id, int cls);

#endif
