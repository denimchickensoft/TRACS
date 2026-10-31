/* Shared helpers for tracs_exporter.dll: a growable string buffer for
   building JSON, the DCS log bridge and the clock. */
#ifndef TRACS_COMMON_H
#define TRACS_COMMON_H

#include <stddef.h>
#include "lua.h"

/* Bumped together with DLL_ABI in the hook whenever the Lua-facing
   functions change; the hook refuses a DLL with a different one. */
#define TRACS_EXPORTER_ABI 2

/* Set by the build from relay/package.json. */
#ifndef TRACS_VERSION
#define TRACS_VERSION "dev"
#endif

/* Wire protocol of the hook <-> relay connection (HOOK_PROTOCOL in
   relay/exporter.js). */
#define HOOK_PROTOCOL 1

typedef struct {
  char *p;
  size_t len, cap;
  int oom;  /* an allocation failed; the contents are incomplete */
} JBuf;

void jb_init(JBuf *b);
void jb_free(JBuf *b);
void jb_put(JBuf *b, const char *s, size_t n);
void jb_puts(JBuf *b, const char *s);
void jb_printf(JBuf *b, const char *fmt, ...);
void jb_str(JBuf *b, const char *s);       /* a quoted, escaped JSON string */
void jb_lstr(JBuf *b, const char *s, size_t n);
void jb_num(JBuf *b, double v);            /* like Lua's tostring: %.14g */

/* Seconds on a monotonic clock. */
double now_s(void);

/* log.write to dcs.log under TRACS.EXPORTER, from the sim thread only. */
enum { LOG_INFO, LOG_WARNING, LOG_ERROR };
void dcs_log(lua_State *L, int level, const char *fmt, ...);

/* Pushes path's value from L's globals ("Unit.getPoint"); nil if missing. */
void push_path(lua_State *L, const char *path);

#endif
