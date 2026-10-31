/* The connection to the relay, on a thread of its own. The sim thread
   queues outgoing lines and polls incoming items; the network thread never
   touches Lua or DCS. */
#ifndef TRACS_NET_H
#define TRACS_NET_H

#include <stddef.h>

typedef enum {
  NET_LINE,          /* one line from the relay (without its newline) */
  NET_CONNECTED,     /* gen: the new connection's generation */
  NET_DISCONNECTED,  /* data: why */
  NET_LOG,           /* level, data: a message for dcs.log */
} NetKind;

typedef struct NetItem {
  struct NetItem *next;
  NetKind kind;
  unsigned gen;
  int level;
  size_t len;
  char data[1];
} NetItem;

void net_init(void);
/* Connects (and keeps reconnecting) to 127.0.0.1:port; starts the thread on
   first use. 0 if the thread couldn't be started. */
int net_connect(int port);
/* Drops the connection and stays disconnected until the next net_connect. */
void net_disconnect(void);
/* Ends the thread (it exits on its own; nothing waits for it). */
void net_shutdown(void);
/* Queues one line (a newline is appended) for connection `gen`. 1 queued,
   0 dropped because that connection is gone, -1 dropped because the send
   buffer is full. */
int net_send(unsigned gen, const char *line, size_t len);
/* Takes every pending incoming item, oldest first; free with net_free. */
NetItem *net_poll(void);
void net_free(NetItem *items);

#endif
