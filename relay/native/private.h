/* The private Lua state each side calls DCS's table-returning functions in
   (see tracs_exporter.c), shared with the collectors in client.c. */
#ifndef TRACS_PRIVATE_H
#define TRACS_PRIVATE_H

#include "lua.h"

typedef struct {
  const char *path;  /* "Namespace.name", looked up in the calling state's globals */
  lua_CFunction fn;
  /* luaOk: may be a Lua function in DCS (read once per unit, so calling it
     in the mission state costs next to nothing); isLua: it is one, found at
     init. Such a function is called in the mission state on an object
     carrying its class's methods instead of in the private state. */
  int luaOk, isLua;
} DcsFn;

typedef struct {
  DcsFn *fns;
  int nFns;
  lua_State *P;      /* private state */
  int ready;         /* init passed */
  int faulted;       /* an exception was caught; never call DCS again this mission */
  char error[512];   /* why not ready, or the fault report */
} Side;

/* Server-side (mission state) functions, in SERVER_FNS order. */
enum {
  S_GET_POINT, S_GET_POSITION, S_GET_VELOCITY, S_GET_LIFE, S_GET_PLAYER_NAME, S_IN_AIR,
  S_GET_COALITION, S_GET_ID, S_GET_CATEGORY, S_GET_CONTROLLER, S_GET_DETECTED_TARGETS,
  S_GET_GROUPS, S_GET_UNITS, S_GET_HEIGHT, S_LO_TO_LL,
  S_IS_EXIST, S_IS_ACTIVE, S_GET_NAME, S_GET_TYPE_NAME, S_GET_CALLSIGN, S_GET_GROUP,
  S_GROUP_GET_ID, S_GROUP_GET_NAME, S_GROUP_GET_CATEGORY, S_HAS_SENSORS,
  S_COUNT
};

enum { C_GET_WORLD_OBJECTS, C_COUNT };

extern Side g_server;
extern Side g_client;

/* An object's id_ as read in one state, to rebuild it in another. */
typedef struct { int type; lua_Number num; void *ptr; } Id;

/* Reads the id_ of the object table at idx; 0 if it has none. */
int readId(lua_State *L, int idx, Id *id);
/* Pushes a bare { id_ = ... } table, all a DCS function reads of an object. */
void pushBare(lua_State *L, const Id *id);

/* lua_pcall in the private state under an SEH guard. The function and its
   arguments are already pushed. 0 ok, 1 Lua error (message on the stack),
   2 exception (fault recorded in s->error, stack left as it is). */
int pcallPrivate(Side *s, int f, int nargs, int nresults, const char *context);

/* lua_pcall in a shared state (the mission state, for a Lua-implemented
   DCS function) under an SEH guard, recording a fault in s like
   pcallPrivate. */
int pcallShared(lua_State *L, Side *s, int f, int nargs, int nresults);

/* Empties the private state's stack and collects its garbage. */
void clearPrivate(Side *s);

#endif
