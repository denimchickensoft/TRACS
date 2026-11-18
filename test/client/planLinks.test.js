import { describe, it, expect, beforeEach, vi } from 'vitest'

// The stores read for the source type and callsigns touch localStorage and
// the window on load.
beforeEach(() => {
  globalThis.window = { location: { search: '' }, addEventListener: () => {} }
  const mem = new Map()
  const storage = () => ({
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  })
  globalThis.localStorage = storage()
  globalThis.sessionStorage = storage()
  vi.resetModules()
})

async function load(sourceType) {
  const { useSessionStore } = await import('../../client/src/store/session.js')
  useSessionStore.setState({ sourceType, useDcsNames: true })
  const planLinks = await import('../../client/src/utils/planLinks.js')
  const engine = await import('../../client/src/modules/atc/shared/associationEngine.js')
  return { ...planLinks, ...engine }
}

// Mission plans for group RMD-5 (DCS group 50, units 501-504) and the
// single-ship VOLVO-1 (group 60), as utils/mizFlightPlans.js files them.
const plan = (aid, bcn, unitIndex, unitName, unitId, position, group = { id: 50, name: 'RMD-5', flightId: 50 }) => ({
  aid, bcn, unitId: null, dcsUnitId: unitId,
  mission: { flightId: group.flightId, coalition: 'blue', dcsGroupId: group.id, dcsGroupName: group.name,
    unitIndex, unitName, unitId, position },
})
const plans = {
  RMD51: plan('RMD51', '4501', 0, 'RMD-5-1', 501, 1),
  RMD52: plan('RMD52', '4502', 1, 'RMD-5-2', 502, 2),
  RMD53: plan('RMD53', '4503', 2, 'RMD-5-3', 503, 3),
  RMD54: plan('RMD54', '4504', 3, 'RMD-5-4', 504, 4),
  VOLVO1: plan('VOLVO1', '4601', 0, 'VOLVO-1', 601, null, { id: 60, name: 'VOLVO-1', flightId: 60 }),
}

// A live player on the exporter client: MP name, group name, runtime ID.
const clientPlayer = (id, mpName, extra = {}) => ({
  id, groupName: 'RMD-5', callsign: mpName, unitName: mpName, human: true, ...extra,
})
const squawking = (code) => ({ srsCapable: true, transponder: { status: 1, mode3: code } })

describe('buildPlanLinks', () => {
  it('Olympus / exporter host: exact by DCS unit ID', async () => {
    const { buildPlanLinks } = await load('olympus')
    const links = buildPlanLinks(plans, {
      7: { id: 7, unitID: 502, groupID: 50, groupName: 'RMD-5', callsign: 'RMD-5-2', unitName: 'MALLET 3-1 | <player>', human: true },
    })
    expect(links.linkOf('7')).toMatchObject({ aid: 'RMD52', exact: true })
  })

  it('exporter client: a player is a guess from the MP callsign digit, with the group offered', async () => {
    const { buildPlanLinks } = await load('exporter')
    const links = buildPlanLinks(plans, {
      16790048: clientPlayer(16790048, 'MALLET 3-1 | <player>'),
      16790050: { id: 16790050, groupName: 'VOLVO-1', callsign: 'VOLVO-1', unitName: 'VOLVO-1' },
    })
    expect(links.linkOf('16790048')).toEqual({
      aid: 'RMD51', exact: false, groupAids: ['RMD51', 'RMD52', 'RMD53', 'RMD54'],
    })
    expect(links.linkOf('16790050')).toMatchObject({ aid: 'VOLVO1', exact: true }) // AI by unit name
  })

  it('Tacview: a unit in the group matching no unit name is the player', async () => {
    const { buildPlanLinks } = await load('tacview')
    const links = buildPlanLinks(plans, { 9: { id: 9, groupID: 'RMD-5', callsign: '', unitName: 'MALLET 3-2 | <player>' } })
    expect(links.linkOf('9')).toMatchObject({ aid: 'RMD52', exact: false })
  })

  it('plans without a mission slot link nothing', async () => {
    const { buildPlanLinks } = await load('exporter')
    const links = buildPlanLinks({ MALLET31: { aid: 'MALLET31', bcn: '1234', unitId: null } },
      { 1: clientPlayer(1, 'MALLET 3-1 | <player>') })
    expect(links.linkOf('1')).toBe(null)
  })
})

describe('computeAssociations with plan links', () => {
  async function associate(sourceType, units, { previous = {}, ownership = {}, flightPlans = plans } = {}) {
    const { getPlanLinks, computeAssociations } = await load(sourceType)
    const { dcsUnitIdReliable } = await import('../../client/src/utils/callsign.js')
    return computeAssociations({
      units, flightPlans, ownership, previousAssociated: previous,
      dcsUnitIdReliable: dcsUnitIdReliable(), planLink: getPlanLinks(flightPlans, units).linkOf,
    })
  }

  it('the squawk picks the slot when the MP digit guessed wrong', async () => {
    // MALLET 3-1 sits in RMD-5-2 and squawks RMD52's code.
    const next = await associate('exporter', { 1: clientPlayer(1, 'MALLET 3-1 | <player>', squawking(4502)) })
    expect(next).toEqual({ 1: 'RMD52' })
  })

  it('a code from another group never associates', async () => {
    const next = await associate('exporter', {
      1: { id: 1, groupName: 'OTHER-1', callsign: 'X', unitName: 'X', human: true, ...squawking(4501) },
    })
    expect(next).toEqual({})
  })

  it('two group-mates squawking one plan code get neither', async () => {
    const next = await associate('exporter', {
      1: clientPlayer(1, 'MALLET 3-1 | <a>', squawking(4501)),
      2: clientPlayer(2, 'MALLET 3-2 | <b>', squawking(4501)),
    })
    expect(next).toEqual({})
  })

  it('an owned association is not taken over', async () => {
    const next = await associate('exporter', {
      1: clientPlayer(1, 'MALLET 3-1 | <a>', squawking(4501)),
      2: clientPlayer(2, 'MALLET 3-2 | <b>', squawking(4501)),
    }, { previous: { 1: 'RMD51' }, ownership: { 1: 'C1' } })
    expect(next).toEqual({ 1: 'RMD51' })
  })

  it('an exact host link only offers its own plan', async () => {
    // Unit 502 squawking RMD51's code: exact link to RMD52, so nothing.
    const next = await associate('olympus', {
      7: { id: 7, unitID: 502, groupID: 50, groupName: 'RMD-5', callsign: 'RMD-5-2', unitName: 'MALLET 3-1 | <p>', human: true, ...squawking(4501) },
    })
    expect(next).toEqual({})
  })

  it('a plan filed under the live callsign still wins', async () => {
    const flightPlans = { ...plans, MALLET31: { aid: 'MALLET31', bcn: '4777', unitId: null } }
    const next = await associate('exporter', { 1: clientPlayer(1, 'MALLET 3-1 | <p>', squawking(4777)) }, { flightPlans })
    expect(next).toEqual({ 1: 'MALLET31' })
  })

  it('with no transponder data (no SRS), identity alone associates, a guess with its guessed slot', async () => {
    const next = await associate('exporter', {
      1: clientPlayer(1, 'MALLET 3-1 | <p>'),
      2: { id: 2, groupName: 'VOLVO-1', callsign: 'VOLVO-1', unitName: 'VOLVO-1' },
    })
    expect(next).toEqual({ 1: 'RMD51', 2: 'VOLVO1' })
  })
})

describe('findFlightPlanAid and .rename', () => {
  async function stores(sourceType) {
    await load(sourceType)
    const { useUnitsStore } = await import('../../client/src/store/units.js')
    const { useAssociationStore } = await import('../../client/src/store/association.js')
    const { useFlightPlansStore } = await import('../../client/src/store/flightPlans.js')
    const { useStripsStore } = await import('../../client/src/store/strips.js')
    const callsign = await import('../../client/src/utils/callsign.js')
    const rename = await import('../../client/src/utils/callsignRename.js')
    return { useUnitsStore, useAssociationStore, useFlightPlansStore, useStripsStore, ...callsign, ...rename }
  }

  it('association first, then the guessed link, else the live callsign', async () => {
    const s = await stores('exporter')
    const unit = clientPlayer(1, 'MALLET 3-1 | <p>')
    s.useUnitsStore.setState({ units: { 1: unit } })
    expect(s.findFlightPlanAid(unit, plans)).toBe('RMD51')             // guess
    s.useAssociationStore.setState({ associated: { 1: 'RMD52' } })
    expect(s.findFlightPlanAid(unit, plans)).toBe('RMD52')             // squawk-confirmed
    expect(s.findFlightPlanAid(clientPlayer(2, 'BOXER 1-1 | <q>', { groupName: 'NONE' }), plans)).toBe('BOXER11')
    expect(s.planLabels({ 1: 'RMD52' }, { 1: unit })).toEqual({ RMD52: 'MALLET31' })
  })

  it('.rename changes only the shown callsign: the plan and its strip keep RMD51', async () => {
    const s = await stores('olympus')
    const unit = { id: 7, unitID: 501, groupID: 50, groupName: 'RMD-5', callsign: 'RMD-5-1', unitName: 'MALLET 3-1 | <p>', human: true }
    s.useUnitsStore.setState({ units: { 7: unit } })
    s.useFlightPlansStore.setState({ plans: { RMD51: { ...plans.RMD51, unitId: 7 } } })
    s.useStripsStore.getState().addStrip('RMD51', { unitId: 7 })
    s.applyCallsignChange(7, unit, 'BOXER11')
    expect(Object.keys(s.useFlightPlansStore.getState().plans)).toEqual(['RMD51'])
    expect(Object.values(s.useStripsStore.getState().strips).map((x) => x.aid)).toEqual(['RMD51'])
    expect(s.resolveCallsign(unit)).toBe('BOXER11')
    s.applyCallsignChange(7, unit, null)
    expect(Object.keys(s.useFlightPlansStore.getState().plans)).toEqual(['RMD51'])
    expect(s.resolveCallsign(unit)).toBe('MALLET31')
  })
})
