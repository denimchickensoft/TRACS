/* The exporter's scheduler: collectors, rates, demand, events, hello and
   timings, driven once per simulation frame from the hook state. */
#ifndef TRACS_SCHED_H
#define TRACS_SCHED_H

#include "lua.h"
#include "common.h"

/* One call of a collector written in C, on the sim thread with the hook
   state. In: start (a new cycle begins), full (send everything, not a
   delta), slices (how many ticks a sliced cycle may spread over),
   sensorUnitsOnly. Out: the data JSON in out, kind ('full' or 'delta'),
   extra timing fields in extra as ',"name":value' pairs, once (skip until
   the next resync), and for a step that ran in the mission state its heap
   before and after (KB; leave -1 otherwise). On -1, error says why, and
   fatal means DCS calls stopped for this mission (a caught exception), so
   the DLL is no longer ready. */
typedef struct {
  int start, full, slices, sensorUnitsOnly;
  JBuf *out, *extra;
  const char *kind;
  int once;
  const char *error;
  int fatal;
  double srvKb0, srvKb1;
} NativeRun;

/* Returns 1 with a result, 0 with nothing to send, 2 when a sliced cycle
   continues next tick, -1 on an error. */
typedef int (*NativeGather)(lua_State *L, NativeRun *r);

typedef struct {
  const char *name;
  NativeGather gather;
  int sliced;
} NativeCollector;

/* Adds register/registerNative/start (the harness test's way in) to the
   module table on top of the stack. natives lists the C collectors that can
   be registered by name, ending with { NULL, NULL, 0 }. */
void sched_open(lua_State *L, const NativeCollector *natives);

/* One of natives, by name, at rate seconds, sending as group (NULL: its
   name). 0 if there's no such collector. */
int sched_registerNative(lua_State *L, const char *name, const char *side, double rate, const char *group);

/* What hello tells the relay about where the running mission's file is:
   the Saved Games folder, the mission file a host loaded, and when the
   mission began to load (ms since 1970). A NULL string is sent as null, as
   is a load time of 0. */
typedef struct {
  const char *savedGames;
  const char *missionFile;
  double loadTimeMs;
} MissionInfo;

/* Mission load: connects to the relay on port. status is the DLL's own
   status as JSON (sent in hello), ready whether collecting may start. info
   may be NULL. */
void sched_start(lua_State *L, int port, int server, int multiplayer, const char *theatre, const char *status,
                 int ready, const MissionInfo *info);
/* The DLL status changed (a pending client self-test finished); the relay
   gets a fresh hello. */
void sched_setStatus(lua_State *L, const char *status, int ready);
/* Every onSimulationFrame, in the hook state. */
void sched_frame(lua_State *L);

/* An event as a JSON object from the mission's event handler, buffered
   until it's sent. Takes b's contents (b is left empty). */
void sched_event(JBuf *b);

/* Mission end: disconnect and forget the mission's state. */
void sched_stop(void);

#endif
