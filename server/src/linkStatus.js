'use strict'

// The 'status' message clients show in the top bar, built from the active
// source's link issue:
//   null                        data is flowing          -> CONNECTED
//   { retrying: true,  reason } stopped responding, being retried
//                                                         -> NO RESPONSE: RECONNECTING
//   { retrying: false, reason } failed, or only retried slowly
//                                                         -> DISCONNECTED (reason)
// `reason` is a key the client maps to text (client/src/ws/client.js).
function statusPayload(sourceType, issue) {
  if (!issue) return { polling: true, sourceType }
  if (issue.retrying) return { polling: true, retrying: true, reason: issue.reason, sourceType }
  return { polling: false, reason: issue.reason, sourceType }
}

module.exports = { statusPayload }
