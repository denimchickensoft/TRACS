/* The exporter's scheduler: collectors, rates, demand, events, hello and
   timings, driven once per simulation frame from the hook state. */
#ifndef TRACS_SCHED_H
#define TRACS_SCHED_H

#include "lua.h"
#include "common.h"

/* A collector written in C. Called on the sim thread with the hook state.
   Writes its data JSON to out, its kind ('full' or 'delta') to *kind and any
   extra timing fields to extra as ',"name":value' pairs; sets *once to skip
   it until the next resync. Returns 1 with a result, 0 with nothing to send,
   -1 on an error (message in *error). *fatal set with -1 means DCS calls
   stopped for this mission (a caught exception), so the DLL is no longer
   ready. */
typedef int (*NativeGather)(lua_State *L, int full, JBuf *out, const char **kind, JBuf *extra, int *once,
                            const char **error, int *fatal);

typedef struct {
  const char *name;
  NativeGather gather;
} NativeCollector;

/* Adds register/registerNative/setEventSource/start/setStatus/frame to the
   module table on top of the stack. natives lists the C collectors
   registerNative can name, ending with { NULL, NULL }. */
void sched_open(lua_State *L, const NativeCollector *natives);
/* Mission end: disconnect and forget the mission's state. */
void sched_stop(void);

#endif
