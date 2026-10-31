/* The exporter's scheduler: collectors, rates, demand, events, hello and
   timings, driven once per simulation frame from the hook state. */
#ifndef TRACS_SCHED_H
#define TRACS_SCHED_H

#include "lua.h"

/* Adds register/setEventSource/start/setStatus/frame to the module table
   on top of the stack. */
void sched_open(lua_State *L);
/* Mission end: disconnect and forget the mission's state. */
void sched_stop(void);

#endif
