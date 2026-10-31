'use strict'

// The 'status' message clients show in the top bar, built from the active
// source's link issue:
//   null                        data is flowing          -> CONNECTED
//   { retrying: true,  reason } stopped responding, being retried
//                                                         -> NO RESPONSE: RECONNECTING
//   { retrying: false, reason } failed, or only retried slowly
//                                                         -> DISCONNECTED (reason)
// `reason` is a key the client maps to text (client/src/ws/client.js); an
// optional `detail` is free text the client appends to it.
function statusPayload(sourceType, issue) {
  if (!issue) return { polling: true, sourceType }
  const detail = issue.detail ? { detail: issue.detail } : {}
  if (issue.retrying) return { polling: true, retrying: true, reason: issue.reason, sourceType, ...detail }
  return { polling: false, reason: issue.reason, sourceType, ...detail }
}

// The 'srs_status' message for the SRS transponder feed (srs.js), shown next
// to the peer count: { issue: null | 'retrying' | 'password' | 'protocol' }.
function srsStatusPayload(issue) {
  if (!issue) return { issue: null }
  return { issue: issue.retrying ? 'retrying' : issue.reason }
}

module.exports = { statusPayload, srsStatusPayload }
