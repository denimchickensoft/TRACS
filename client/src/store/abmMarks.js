import { create } from 'zustand'
import { syncStore } from '../utils/storeSync.js'
import { createBroadcastHook } from '../utils/broadcastRegistry.js'
import { useSessionStore } from './session.js'
import { buildMarkFeature } from '../utils/drawShapes.js'

// ABM marks (.mark, INS + click, Alt+right-click): point markers shared with
// every ABM controller for as long as anyone is in ABM. They're never saved
// locally, so a mark removed while someone was away can't come back from a
// stale copy.
//
// Any controller can move, rename, recolor or remove any mark. Each change
// sends the whole mark (MARK_SET) with a higher rev; a receiver keeps
// whichever copy has the higher (rev, by), so every client settles on the
// same mark whatever order the messages arrive in. A removed mark stays as a
// `deleted` tombstone for the session, so a late or stale copy (an older
// STATE_DUMP, say) can't bring it back. The ABM state dump carries every
// mark, tombstones included, merged the same way.
//
// Hiding a mark is this controller's own choice (`hidden`), never sent.
//
// marks:  { [id]: { id, name, lat, lng, label, color, rev, by, deleted? } }
// hidden: { [id]: true }

const { register: registerAbmMarksBroadcast, broadcast } = createBroadcastHook()
export { registerAbmMarksBroadcast }

export const useAbmMarksStore = create(() => ({
  marks:  {},
  hidden: {},
}))

syncStore(useAbmMarksStore, 'tracs-abm-marks', (s) => ({ marks: s.marks, hidden: s.hidden }))

let lastRev = 0
function nextRev() {
  lastRev = Math.max(Date.now(), lastRev + 1)
  return lastRev
}

function newer(a, b) {
  if (!b) return true
  if (a.rev !== b.rev) return a.rev > b.rev
  return String(a.by) > String(b.by)
}

function apply(mark) {
  if (!mark?.id) return
  lastRev = Math.max(lastRev, mark.rev ?? 0)
  useAbmMarksStore.setState((s) =>
    newer(mark, s.marks[mark.id]) ? { marks: { ...s.marks, [mark.id]: mark } } : s)
}

function publish(mark) {
  apply(mark)
  broadcast('MARK_SET', { mark })
}

function me() {
  return useSessionStore.getState().positionName || 'ABM'
}

// MARK1, MARK2, ... (tombstones count, so a name isn't reused this session)
function nextName() {
  let max = 0
  for (const m of Object.values(useAbmMarksStore.getState().marks)) {
    const n = /^MARK(\d+)$/.exec(m.name ?? '')
    if (n) max = Math.max(max, parseInt(n[1], 10))
  }
  return `MARK${max + 1}`
}

export function addMark({ lat, lng }, label = '') {
  const mark = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: nextName(),
    lat, lng,
    label: label || '',
    color: null,
    rev: nextRev(),
    by: me(),
  }
  publish(mark)
  return mark
}

export function updateMark(id, patch) {
  const cur = useAbmMarksStore.getState().marks[id]
  if (!cur || cur.deleted) return
  publish({ ...cur, ...patch, rev: nextRev(), by: me() })
}

// While a mark is being dragged: move it on this scope only, then
// updateMark() once on release.
export function moveMarkLocally(id, lat, lng) {
  useAbmMarksStore.setState((s) => {
    const cur = s.marks[id]
    return cur ? { marks: { ...s.marks, [id]: { ...cur, lat, lng } } } : s
  })
}

export function removeMark(id) {
  const cur = useAbmMarksStore.getState().marks[id]
  if (!cur || cur.deleted) return
  publish({ ...cur, deleted: true, rev: nextRev(), by: me() })
}

export function removeMarksByName(name) {
  const target = name.toUpperCase()
  const hits = Object.values(useAbmMarksStore.getState().marks)
    .filter((m) => !m.deleted && (m.name ?? '').toUpperCase() === target)
  for (const m of hits) removeMark(m.id)
  return hits.length
}

export function toggleMarkHidden(id) {
  useAbmMarksStore.setState((s) => {
    const hidden = { ...s.hidden }
    if (hidden[id]) delete hidden[id]
    else hidden[id] = true
    return { hidden }
  })
}

// MARK_SET from another controller.
export function applyRemoteMark(mark) { apply(mark) }

// ABM state dump: send everything, merge on receipt (never replace).
export function getMarksDump() { return useAbmMarksStore.getState().marks }
export function applyMarksDump(marks) {
  for (const m of Object.values(marks ?? {})) apply(m)
}

// Marks shaped like command-drawn drawing layers, so the ABM renderer,
// hit-tests and Drawings panel can treat them alongside the local drawings.
// `markId` tells them apart; params.at is what Shift+right-drag moves.
export function marksAsLayers(marks, hidden) {
  return Object.values(marks)
    .filter((m) => !m.deleted)
    .map((m) => ({
      id: `mark:${m.id}`,
      markId: m.id,
      name: m.name,
      color: m.color,
      colorOverride: !!m.color,
      visible: !hidden[m.id],
      labelOverride: false,
      shapeType: 'mark',
      params: { at: { lat: m.lat, lng: m.lng } },
      features: [buildMarkFeature({ at: { lat: m.lat, lng: m.lng }, label: m.label })],
    }))
}
