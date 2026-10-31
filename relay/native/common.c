#define LUA_BUILD_AS_DLL
#include <windows.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "common.h"

void jb_init(JBuf *b) {
  b->p = NULL;
  b->len = b->cap = 0;
  b->oom = 0;
}

void jb_free(JBuf *b) {
  free(b->p);
  jb_init(b);
}

static int reserve(JBuf *b, size_t extra) {
  if (b->oom) return 0;
  if (b->len + extra + 1 <= b->cap) return 1;
  size_t cap = b->cap ? b->cap : 256;
  while (cap < b->len + extra + 1) cap *= 2;
  char *p = realloc(b->p, cap);
  if (!p) { b->oom = 1; return 0; }
  b->p = p;
  b->cap = cap;
  return 1;
}

void jb_put(JBuf *b, const char *s, size_t n) {
  if (!reserve(b, n)) return;
  memcpy(b->p + b->len, s, n);
  b->len += n;
  b->p[b->len] = 0;
}

void jb_puts(JBuf *b, const char *s) { jb_put(b, s, strlen(s)); }

void jb_printf(JBuf *b, const char *fmt, ...) {
  char tmp[512];
  va_list ap;
  va_start(ap, fmt);
  int n = _vsnprintf_s(tmp, sizeof tmp, _TRUNCATE, fmt, ap);
  va_end(ap);
  jb_put(b, tmp, n < 0 ? strlen(tmp) : (size_t)n);
}

void jb_lstr(JBuf *b, const char *s, size_t n) {
  static const char HEX[] = "0123456789abcdef";
  jb_put(b, "\"", 1);
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') { char e[2] = { '\\', (char)c }; jb_put(b, e, 2); }
    else if (c == '\n') jb_put(b, "\\n", 2);
    else if (c == '\r') jb_put(b, "\\r", 2);
    else if (c == '\t') jb_put(b, "\\t", 2);
    else if (c < 0x20) { char e[6] = { '\\', 'u', '0', '0', HEX[c >> 4], HEX[c & 15] }; jb_put(b, e, 6); }
    else jb_put(b, (const char *)&c, 1);
  }
  jb_put(b, "\"", 1);
}

void jb_str(JBuf *b, const char *s) { jb_lstr(b, s, strlen(s)); }

void jb_num(JBuf *b, double v) {
  /* JSON has no inf/nan. */
  if (v != v || v > 1e300 || v < -1e300) { jb_puts(b, "null"); return; }
  jb_printf(b, "%.14g", v);
}

double now_s(void) {
  static LARGE_INTEGER freq;
  LARGE_INTEGER c;
  if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&c);
  return (double)c.QuadPart / (double)freq.QuadPart;
}

void dcs_log(lua_State *L, int level, const char *fmt, ...) {
  static const char *LEVELS[] = { "INFO", "WARNING", "ERROR" };
  char msg[1024];
  va_list ap;
  va_start(ap, fmt);
  _vsnprintf_s(msg, sizeof msg, _TRUNCATE, fmt, ap);
  va_end(ap);
  int top = lua_gettop(L);
  lua_getglobal(L, "log");
  if (lua_istable(L, -1)) {
    lua_getfield(L, -1, "write");
    lua_pushstring(L, "TRACS.EXPORTER");
    lua_getfield(L, -3, LEVELS[level]);
    lua_pushstring(L, msg);
    lua_pcall(L, 3, 0, 0);
  }
  lua_settop(L, top);
}

void push_path(lua_State *L, const char *path) {
  char ns[64];
  const char *dot = strchr(path, '.');
  size_t n = dot ? (size_t)(dot - path) : 0;
  if (!dot || n >= sizeof ns) { lua_pushnil(L); return; }
  memcpy(ns, path, n);
  ns[n] = 0;
  lua_getglobal(L, ns);
  if (!lua_istable(L, -1)) return;
  lua_getfield(L, -1, dot + 1);
  lua_remove(L, -2);
}
