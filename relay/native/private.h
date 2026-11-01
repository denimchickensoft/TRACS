/* The private Lua state each side calls DCS's table-returning functions in
   (see tracs_exporter.c), shared with the collectors in client.c. */
#ifndef TRACS_PRIVATE_H
#define TRACS_PRIVATE_H

#include "lua.h"

typedef struct {
  const char *path;  /* "Namespace.name", looked up in the calling state's globals */
  lua_CFunction fn;
} DcsFn;

typedef struct {
  DcsFn *fns;
  int nFns;
  lua_State *P;      /* private state */
  int ready;         /* init passed */
  int faulted;       /* an exception was caught; never call DCS again this mission */
  char error[512];   /* why not ready, or the fault report */
} Side;

enum { C_GET_WORLD_OBJECTS, C_COUNT };

extern Side g_client;

/* lua_pcall in the private state under an SEH guard. The function and its
   arguments are already pushed. 0 ok, 1 Lua error (message on the stack),
   2 exception (fault recorded in s->error, stack left as it is). */
int pcallPrivate(Side *s, int f, int nargs, int nresults, const char *context);

/* Empties the private state's stack and collects its garbage. */
void clearPrivate(Side *s);

#endif
