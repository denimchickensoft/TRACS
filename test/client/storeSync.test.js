import { describe, test, expect, afterEach } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { syncStore, shallowEqual, setChannelIdentity, positionChannel } from '../../client/src/utils/storeSync.js'

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

// Every channel opened by a test, closed afterwards so the process can exit.
let opened = []
const channel = (name) => {
  const ch = new BroadcastChannel(name)
  opened.push(ch)
  return ch
}
afterEach(() => {
  for (const ch of opened) ch.close()
  opened = []
})

// Counts every message seen on the given channel names.
function counter(names) {
  const counts = Object.fromEntries(names.map((n) => [n, 0]))
  for (const n of names) channel(n).onmessage = () => { counts[n]++ }
  return counts
}

describe('shallowEqual', () => {
  test('same references are equal', () => {
    const o = {}
    expect(shallowEqual({ a: o, b: 1 }, { a: o, b: 1 })).toBe(true)
  })
  test('a new reference, a different key set or a missing key is not equal', () => {
    expect(shallowEqual({ a: {} }, { a: {} })).toBe(false)
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(shallowEqual({ a: undefined }, { b: undefined })).toBe(false)
  })
})

// The sync mechanics, on the browser-wide channel (no position needed).
describe('syncStore', () => {
  test('an unrelated store change does not post', async () => {
    const name = 'test-unrelated'
    const store = createStore(() => ({ picked: 1, other: 1 }))
    syncStore(store, name, (s) => ({ picked: s.picked }), { global: true })
    const counts = counter([name])
    await settle()
    const before = counts[name]
    store.setState({ other: 2 })
    await settle()
    expect(counts[name]).toBe(before)
    store.setState({ picked: 2 })
    await settle()
    expect(counts[name]).toBe(before + 1)
  })

  // The store/atc.js shape: one store carrying a main-to-popup ownership
  // channel plus a symmetric syncStore channel. The main window's ownership
  // poster is left unguarded here on purpose, to show the syncStore change
  // alone stops the ping-pong that froze pop-outs.
  test('two channels on one store settle instead of ping-ponging, with several pop-outs', async () => {
    const own = 'test-ownership'
    const cs  = 'test-callsigns'
    const initial = () => ({ ownership: {}, callsignOverrides: {} })

    const main = createStore(initial)
    const mainOwnCh = channel(own)
    main.subscribe((s) => mainOwnCh.postMessage({ type: 'STATE_UPDATE', state: { ownership: s.ownership } }))
    syncStore(main, cs, (s) => ({ callsignOverrides: s.callsignOverrides }), { global: true })

    const popups = [0, 1, 2].map(() => {
      const popup = createStore(initial)
      channel(own).onmessage = (e) => {
        if (e.data?.type === 'STATE_UPDATE') popup.setState({ ownership: e.data.state.ownership })
      }
      syncStore(popup, cs, (s) => ({ callsignOverrides: s.callsignOverrides }), { global: true })
      return popup
    })

    await settle()
    const counts = counter([own, cs])

    main.setState({ ownership: { A1: 'C1' } })
    await settle(300)
    for (const p of popups) expect(p.getState().ownership).toEqual({ A1: 'C1' })
    expect(counts[own]).toBe(1)
    expect(counts[cs]).toBe(0)

    // A rename in one pop-out reaches the main window and the other pop-outs.
    popups[0].setState({ callsignOverrides: { 42: 'COLT11' } })
    await settle(300)
    expect(main.getState().callsignOverrides).toEqual({ 42: 'COLT11' })
    for (const p of popups) expect(p.getState().callsignOverrides).toEqual({ 42: 'COLT11' })
    // The main window's unguarded poster fires once more on applying the rename.
    expect(counts[own]).toBe(2)
    expect(counts[cs]).toBe(1)
  })

  test('REQUEST_STATE is always answered with the current slice', async () => {
    const name = 'test-request'
    const store = createStore(() => ({ picked: 7 }))
    syncStore(store, name, (s) => ({ picked: s.picked }), { global: true })
    const replies = []
    const probe = channel(name)
    probe.onmessage = (e) => { if (e.data?.type === 'STATE_UPDATE') replies.push(e.data.state) }
    probe.postMessage({ type: 'REQUEST_STATE' })
    await settle()
    expect(replies).toEqual([{ picked: 7 }])
  })
})

describe('position-scoped channels', () => {
  afterEach(() => setChannelIdentity('', ''))

  test('a window with no position yet (sign-in) syncs nothing', async () => {
    const name = 'test-unsigned'
    const store = createStore(() => ({ picked: 1 }))
    syncStore(store, name, (s) => ({ picked: s.picked }))
    const counts = counter([name])
    store.setState({ picked: 2 })
    await settle()
    expect(counts[name]).toBe(0)
  })

  test('joins <channel>-<facility>-<position> once the position is set, and asks for state', async () => {
    const name = 'test-scoped'
    const store = createStore(() => ({ picked: 1 }))
    syncStore(store, name, (s) => ({ picked: s.picked }))
    const scoped = []
    channel(`${name}-KXYZ-APP1`).onmessage = (e) => scoped.push(e.data.type)
    const other = counter([`${name}-KXYZ-APP2`, name])
    setChannelIdentity('KXYZ', 'APP1')
    await settle()
    store.setState({ picked: 2 })
    await settle()
    expect(scoped).toEqual(['REQUEST_STATE', 'STATE_UPDATE'])
    expect(other[`${name}-KXYZ-APP2`]).toBe(0)
    expect(other[name]).toBe(0)
  })

  test('another position never hears it', async () => {
    const name = 'test-isolated'
    setChannelIdentity('KXYZ', 'APP1')
    const store = createStore(() => ({ picked: 1 }))
    syncStore(store, name, (s) => ({ picked: s.picked }))
    const foreign = channel(`${name}-KXYZ-APP2`)
    foreign.postMessage({ type: 'STATE_UPDATE', state: { picked: 99 } })
    await settle()
    expect(store.getState().picked).toBe(1)
  })

  test('a hand-rolled positionChannel re-joins when the position changes', async () => {
    const name = 'test-rejoin'
    const opens = []
    positionChannel(name, { onOpen: () => opens.push('open') })
    setChannelIdentity('KXYZ', 'APP1')
    setChannelIdentity('KXYZ', 'APP2')
    expect(opens).toEqual(['open', 'open'])
  })
})
