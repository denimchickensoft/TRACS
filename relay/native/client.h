/* Client-side collectors (a multiplayer client's hook state), in C. */
#ifndef TRACS_CLIENT_H
#define TRACS_CLIENT_H

#include "sched.h"

/* units_client, exportStatus, bullseyes_client, clock_client,
   airbases_client; ends with { NULL, NULL }. */
extern const NativeCollector CLIENT_COLLECTORS[];

/* Forgets the mission's unit records and cached mission data. */
void client_reset(void);

#endif
