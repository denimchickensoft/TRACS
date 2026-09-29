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

// The 'srs_status' message for the SRS transponder feed (srs.js), shown next
// to the peer count: { issue: null | 'retrying' | 'password' | 'protocol' }.
function srsStatusPayload(issue) {
  if (!issue) return { issue: null }
  return { issue: issue.retrying ? 'retrying' : issue.reason }
}

module.exports = { statusPayload, srsStatusPayload }
