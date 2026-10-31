/* See net.h. Winsock with WSAEventSelect: the thread waits on the socket's
   event and on g_wake, which the sim thread sets when it queues a line or
   changes the target, so nothing polls.

   Every outgoing line carries the generation of the connection it was meant
   for. A line queued for a connection that has since dropped is discarded,
   so nothing from before a reconnect goes out ahead of the new hello.

   The thread holds its own reference to this DLL and leaves through
   FreeLibraryAndExitThread: if DCS unloads the DLL (closing the Lua state
   that loaded it) while the thread still runs, the code stays mapped until
   the thread is done. */

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "net.h"

#define CONNECT_TIMEOUT_MS 2000
#define BACKOFF_MIN_MS     2000
#define BACKOFF_MAX_MS     30000
#define MAX_TX_BYTES       (8u * 1024 * 1024)
#define MAX_RX_LINE        (1u * 1024 * 1024)
/* How long the thread waits with nothing happening before rechecking its
   target; a backstop only, every change also sets g_wake. */
#define IDLE_WAIT_MS       1000

typedef struct OutLine {
  struct OutLine *next;
  unsigned gen;
  size_t len;
  char data[1];
} OutLine;

static CRITICAL_SECTION g_lock;
static HANDLE g_wake;
static HANDLE g_thread;
/* Under g_lock: */
static int g_targetPort;         /* 0 = stay disconnected */
static unsigned g_targetSeq;     /* bumped by every connect/disconnect request */
static int g_shutdown;
static unsigned g_gen;           /* the live connection's generation, 0 = none */
static unsigned g_lastGen;
static OutLine *g_out, *g_outTail;
static size_t g_outBytes;
static NetItem *g_in, *g_inTail;

void net_init(void) {
  InitializeCriticalSection(&g_lock);
  g_wake = CreateEventW(NULL, FALSE, FALSE, NULL);
}

static void postItem(NetKind kind, unsigned gen, int level, const char *data, size_t len) {
  NetItem *it = malloc(sizeof *it + len);
  if (!it) return;
  it->next = NULL;
  it->kind = kind;
  it->gen = gen;
  it->level = level;
  it->len = len;
  memcpy(it->data, data, len);
  it->data[len] = 0;
  EnterCriticalSection(&g_lock);
  if (g_inTail) g_inTail->next = it; else g_in = it;
  g_inTail = it;
  LeaveCriticalSection(&g_lock);
}

static void postf(NetKind kind, unsigned gen, int level, const char *fmt, ...) {
  char msg[256];
  va_list ap;
  va_start(ap, fmt);
  _vsnprintf_s(msg, sizeof msg, _TRUNCATE, fmt, ap);
  va_end(ap);
  postItem(kind, gen, level, msg, strlen(msg));
}

/* Under g_lock. */
static void dropOutLocked(void) {
  while (g_out) {
    OutLine *o = g_out;
    g_out = o->next;
    free(o);
  }
  g_outTail = NULL;
  g_outBytes = 0;
}

/* Under g_lock: the next line for connection gen, skipping stale ones. Its
   bytes stay counted until the caller has sent it. */
static OutLine *popOutLocked(unsigned gen) {
  while (g_out) {
    OutLine *o = g_out;
    g_out = o->next;
    if (!g_out) g_outTail = NULL;
    if (o->gen == gen) return o;
    g_outBytes -= o->len;
    free(o);
  }
  return NULL;
}

static void describeError(int code, char *out, size_t n) {
  char msg[160] = "";
  FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL, (DWORD)code, 0, msg, sizeof msg, NULL);
  size_t len = strlen(msg);
  while (len && (msg[len - 1] == '\n' || msg[len - 1] == '\r' || msg[len - 1] == '.')) msg[--len] = 0;
  _snprintf_s(out, n, _TRUNCATE, "%s (%d)", len ? msg : "socket error", code);
}

/* A connected socket, or INVALID_SOCKET with the reason in `why`. */
static SOCKET connectTo(int port, WSAEVENT ev, char *why, size_t n) {
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) { describeError(WSAGetLastError(), why, n); return s; }
  BOOL noDelay = TRUE;
  setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char *)&noDelay, sizeof noDelay);
  /* WSAEventSelect also makes the socket non-blocking. */
  WSAEventSelect(s, ev, FD_CONNECT);
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons((u_short)port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(s, (struct sockaddr *)&a, sizeof a) == SOCKET_ERROR && WSAGetLastError() != WSAEWOULDBLOCK) {
    describeError(WSAGetLastError(), why, n);
    closesocket(s);
    return INVALID_SOCKET;
  }
  if (WSAWaitForMultipleEvents(1, &ev, FALSE, CONNECT_TIMEOUT_MS, FALSE) != WSA_WAIT_EVENT_0) {
    _snprintf_s(why, n, _TRUNCATE, "connect timeout");
    closesocket(s);
    return INVALID_SOCKET;
  }
  WSANETWORKEVENTS ne;
  memset(&ne, 0, sizeof ne);
  if (WSAEnumNetworkEvents(s, ev, &ne) != 0 || !(ne.lNetworkEvents & FD_CONNECT) || ne.iErrorCode[FD_CONNECT_BIT]) {
    describeError(ne.iErrorCode[FD_CONNECT_BIT] ? ne.iErrorCode[FD_CONNECT_BIT] : WSAGetLastError(), why, n);
    closesocket(s);
    return INVALID_SOCKET;
  }
  WSAEventSelect(s, ev, FD_READ | FD_WRITE | FD_CLOSE);
  return s;
}

typedef struct {
  char *p;
  size_t len, cap;
} RxBuf;

/* Reads everything available, posting complete lines. 0 while the
   connection is fine, 1 when it has ended (reason in why). */
static int receive(SOCKET s, unsigned gen, RxBuf *rx, char *why, size_t n) {
  char chunk[16384];
  for (;;) {
    int got = recv(s, chunk, sizeof chunk, 0);
    if (got == 0) { _snprintf_s(why, n, _TRUNCATE, "relay closed the connection"); return 1; }
    if (got == SOCKET_ERROR) {
      int e = WSAGetLastError();
      if (e == WSAEWOULDBLOCK) return 0;
      describeError(e, why, n);
      return 1;
    }
    for (int i = 0; i < got; i++) {
      if (chunk[i] == '\n') {
        size_t len = rx->len;
        if (len && rx->p[len - 1] == '\r') len--;
        if (len) postItem(NET_LINE, gen, 0, rx->p, len);
        rx->len = 0;
        continue;
      }
      if (rx->len + 1 > rx->cap) {
        if (rx->cap >= MAX_RX_LINE) { _snprintf_s(why, n, _TRUNCATE, "relay sent an over-long line"); return 1; }
        size_t cap = rx->cap ? rx->cap * 2 : 4096;
        char *p = realloc(rx->p, cap);
        if (!p) { _snprintf_s(why, n, _TRUNCATE, "out of memory"); return 1; }
        rx->p = p;
        rx->cap = cap;
      }
      rx->p[rx->len++] = chunk[i];
    }
  }
}

/* Runs one connection until it ends. 1 if it ended on its own (an error or
   the relay closing it, so the next attempt backs off), 0 if the hook asked
   for it (any connect/disconnect request since, or shutdown). */
static int runConnection(SOCKET s, WSAEVENT ev, unsigned seq, unsigned gen, char *why, size_t n) {
  RxBuf rx = { NULL, 0, 0 };
  OutLine *cur = NULL;
  size_t curOff = 0;
  int canWrite = 1, ended = -1;
  HANDLE waits[2] = { ev, g_wake };

  while (ended < 0) {
    EnterCriticalSection(&g_lock);
    int stop = g_shutdown || g_targetSeq != seq;
    LeaveCriticalSection(&g_lock);
    if (stop) { _snprintf_s(why, n, _TRUNCATE, "closed by the hook"); ended = 0; break; }

    while (canWrite) {
      if (!cur) {
        EnterCriticalSection(&g_lock);
        cur = popOutLocked(gen);
        LeaveCriticalSection(&g_lock);
        curOff = 0;
        if (!cur) break;
      }
      int sent = send(s, cur->data + curOff, (int)(cur->len - curOff), 0);
      if (sent == SOCKET_ERROR) {
        int e = WSAGetLastError();
        if (e == WSAEWOULDBLOCK) { canWrite = 0; break; }
        describeError(e, why, n);
        ended = 1;
        break;
      }
      curOff += (size_t)sent;
      if (curOff == cur->len) {
        EnterCriticalSection(&g_lock);
        g_outBytes -= cur->len;
        LeaveCriticalSection(&g_lock);
        free(cur);
        cur = NULL;
      }
    }
    if (ended >= 0) break;

    DWORD r = WSAWaitForMultipleEvents(2, waits, FALSE, IDLE_WAIT_MS, FALSE);
    if (r != WSA_WAIT_EVENT_0) continue;
    WSANETWORKEVENTS ne;
    if (WSAEnumNetworkEvents(s, ev, &ne) != 0) { describeError(WSAGetLastError(), why, n); ended = 1; break; }
    if (ne.lNetworkEvents & FD_WRITE) canWrite = 1;
    if (ne.lNetworkEvents & (FD_READ | FD_CLOSE)) {
      if (receive(s, gen, &rx, why, n)) ended = 1;
    }
    if (ended < 0 && (ne.lNetworkEvents & FD_CLOSE)) {
      _snprintf_s(why, n, _TRUNCATE, "relay closed the connection");
      ended = 1;
    }
  }

  if (cur) {
    EnterCriticalSection(&g_lock);
    g_outBytes -= cur->len;
    LeaveCriticalSection(&g_lock);
    free(cur);
  }
  free(rx.p);
  return ended;
}

static DWORD WINAPI netThread(LPVOID self) {
  HMODULE module = (HMODULE)self;
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    postf(NET_LOG, 0, 2, "network thread: WSAStartup failed");
    FreeLibraryAndExitThread(module, 0);
  }
  WSAEVENT ev = WSACreateEvent();
  DWORD backoff = BACKOFF_MIN_MS;
  int reported = 0;  /* the current outage has been logged */
  char why[192];

  for (;;) {
    EnterCriticalSection(&g_lock);
    int port = g_targetPort, stop = g_shutdown;
    unsigned seq = g_targetSeq;
    LeaveCriticalSection(&g_lock);
    if (stop) break;
    if (!port) {
      backoff = BACKOFF_MIN_MS;
      reported = 0;
      WaitForSingleObject(g_wake, IDLE_WAIT_MS);
      continue;
    }

    SOCKET s = connectTo(port, ev, why, sizeof why);
    if (s == INVALID_SOCKET) {
      if (!reported) postf(NET_LOG, 0, 0, "relay not reachable on 127.0.0.1:%d (%s) - retrying", port, why);
      reported = 1;
      WaitForSingleObject(g_wake, backoff);
      backoff = backoff * 2 > BACKOFF_MAX_MS ? BACKOFF_MAX_MS : backoff * 2;
      continue;
    }

    EnterCriticalSection(&g_lock);
    unsigned gen = ++g_lastGen ? g_lastGen : ++g_lastGen;
    g_gen = gen;
    dropOutLocked();
    LeaveCriticalSection(&g_lock);
    backoff = BACKOFF_MIN_MS;
    reported = 0;
    postf(NET_CONNECTED, gen, 0, "%d", port);

    int byItself = runConnection(s, ev, seq, gen, why, sizeof why);
    closesocket(s);
    WSAResetEvent(ev);
    EnterCriticalSection(&g_lock);
    g_gen = 0;
    dropOutLocked();
    LeaveCriticalSection(&g_lock);
    postItem(NET_DISCONNECTED, gen, 0, why, strlen(why));
    if (byItself) WaitForSingleObject(g_wake, backoff);
  }

  WSACloseEvent(ev);
  WSACleanup();
  FreeLibraryAndExitThread(module, 0);
}

int net_connect(int port) {
  EnterCriticalSection(&g_lock);
  int stopping = g_shutdown;
  LeaveCriticalSection(&g_lock);
  /* A thread told to shut down (its Lua state closed) is let go first. */
  if (g_thread && (stopping || WaitForSingleObject(g_thread, 0) == WAIT_OBJECT_0)) {
    WaitForSingleObject(g_thread, CONNECT_TIMEOUT_MS + IDLE_WAIT_MS);
    CloseHandle(g_thread);
    g_thread = NULL;
  }
  EnterCriticalSection(&g_lock);
  g_targetPort = port;
  g_targetSeq++;
  g_shutdown = 0;
  LeaveCriticalSection(&g_lock);
  if (!g_thread) {
    HMODULE self;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, (LPCWSTR)(void *)netThread, &self)) return 0;
    g_thread = CreateThread(NULL, 0, netThread, self, 0, NULL);
    if (!g_thread) { FreeLibrary(self); return 0; }
  }
  SetEvent(g_wake);
  return 1;
}

void net_disconnect(void) {
  EnterCriticalSection(&g_lock);
  g_targetPort = 0;
  g_targetSeq++;
  LeaveCriticalSection(&g_lock);
  SetEvent(g_wake);
}

void net_shutdown(void) {
  EnterCriticalSection(&g_lock);
  g_targetPort = 0;
  g_targetSeq++;
  g_shutdown = 1;
  LeaveCriticalSection(&g_lock);
  SetEvent(g_wake);
}

int net_send(unsigned gen, const char *line, size_t len) {
  OutLine *o;
  int r;
  EnterCriticalSection(&g_lock);
  if (!gen || gen != g_gen) r = 0;
  else if (g_outBytes + len + 1 > MAX_TX_BYTES) r = -1;
  else r = 1;
  LeaveCriticalSection(&g_lock);
  if (r != 1) return r;
  o = malloc(sizeof *o + len + 1);
  if (!o) return -1;
  o->next = NULL;
  o->gen = gen;
  o->len = len + 1;
  memcpy(o->data, line, len);
  o->data[len] = '\n';
  EnterCriticalSection(&g_lock);
  if (gen != g_gen) {
    LeaveCriticalSection(&g_lock);
    free(o);
    return 0;
  }
  if (g_outTail) g_outTail->next = o; else g_out = o;
  g_outTail = o;
  g_outBytes += o->len;
  LeaveCriticalSection(&g_lock);
  SetEvent(g_wake);
  return 1;
}

NetItem *net_poll(void) {
  EnterCriticalSection(&g_lock);
  NetItem *items = g_in;
  g_in = g_inTail = NULL;
  LeaveCriticalSection(&g_lock);
  return items;
}

void net_free(NetItem *items) {
  while (items) {
    NetItem *next = items->next;
    free(items);
    items = next;
  }
}
