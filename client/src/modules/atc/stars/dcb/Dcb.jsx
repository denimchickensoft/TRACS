import { useState, useCallback, useMemo, useRef } from 'react'
import { useWheelDirection } from '../../../../utils/wheel.js'
import { useDisplayStore }  from '../../../../store/display.js'
import { usePresetsStore }  from '../../../../store/presets.js'
import { usePreviewStore }  from '../../../../store/preview.js'
import { useMapsStore }     from '../../../../store/maps.js'
import { useRunwaysStore }  from '../../../../store/runways.js'
import { useHoldingsStore } from '../../../../store/holdings.js'
import { useAirwaysStore }  from '../../../../store/airways.js'
import { useMsaStore }      from '../../../../store/msa.js'
import { useMoraStore }       from '../../../../store/mora.js'
import { useReliefStore }     from '../../../../store/relief.js'
import { useMvaStore }        from '../../../../store/mva.js'
import { useGeoStore }        from '../../../../store/geo.js'
import { useFixesStore }      from '../../../../store/fixes.js'
import { useProceduresStore } from '../../../../store/procedures.js'
import { saveStarsPrefs }     from '../../../../store/starsPrefs.js'
import { useUnitSystem }      from '../../../../store/unitSystem.js'
import { recenterScope }      from '../../actions/index.js'
import { useNonPassiveWheel } from '../../../../utils/useNonPassiveWheel.js'
import { snapshotLayerVisibility, applyLayerVisibility } from '../layerVisibility.js'
import { WINDOW_ID, MAIN_BUTTONS, AUX_BUTTONS, SUBMENU_DEFS, VALUE_CONFIG, getWindowValue, applyValueDelta, DEFAULT_DCB, MAP_SLOT_KEYS, mapKeyOf } from './dcbMenus.js'
import '../../dcb.css'

function DcbButton({ btn, isActive, isToggled, valStr, colors, half, onClick }) {
  if (btn.type === 'spacer') {
    return <div className={`dcb-spacer${half ? ' dcb-spacer--half' : ''}`} />
  }

  const lit = isActive || isToggled

  const style = {
    background:  lit ? colors.buttonActiveBackground : colors.buttonBackground,
    borderColor: lit ? colors.buttonActiveBorder     : colors.buttonBorder,
    color:       lit ? colors.buttonActiveText        : colors.buttonText,
  }

  return (
    <button
      className={`dcb-btn${lit ? ' dcb-btn--lit' : ''}${half ? ' dcb-btn--half' : ''}`}
      style={style}
      onClick={onClick}
      tabIndex={-1}
    >
      <span className="dcb-btn-label">
        {btn.lines.map((line, i) => (
          <span key={i} className="dcb-btn-line">{line}</span>
        ))}
      </span>
      {valStr != null && (
        <span className="dcb-btn-value" style={{ color: lit ? colors.buttonActiveText : colors.valueColor }}>
          {valStr}
        </span>
      )}
    </button>
  )
}

// ─── Dcb ─────────────────────────────────────────────────────────────────────

export function Dcb({ profile, briteDcb, csDcb }) {
  const wheelDir = useWheelDirection()
  const barRef   = useRef(null)
  const [menuKey, setMenuKey] = useState('main')

  const updateWindow = useDisplayStore((s) => s.updateWindow)
  const unitSystem       = useUnitSystem('atc')
  const windowSettings   = useDisplayStore((s) => s.windows[WINDOW_ID])

  const presetSlots    = usePresetsStore((s) => s.slots)
  const activePreset   = usePresetsStore((s) => s.activeSlot)
  const defaultPreset  = usePresetsStore((s) => s.defaultSlot)
  const presetPending  = usePresetsStore((s) => s.pendingMode)

  // activeButton lives in the store so AtcScope can inhibit zoom while a spinner is selected
  const activeButton = windowSettings?.dcbActiveSpinner ?? null
  const mapsVisible   = useMapsStore((s) => s.visible)
  const maps          = useMapsStore((s) => s.maps)
  const mvaSlot       = useMapsStore((s) => s.mvaSlot)

  const holdsVisible   = useHoldingsStore((s) => s.visible)
  const airwaysVisible = useAirwaysStore((s) => s.visible)
  const msaVisible     = useMsaStore((s) => s.visible)
  const moraVisible    = useMoraStore((s) => s.visible)
  const reliefVisible  = useReliefStore((s) => s.visible)
  const mvaVisible     = useMvaStore((s) => s.visible)
  const geoVisible     = useGeoStore((s) => s.visible)
  const fixesVisible   = useFixesStore((s) => s.visible)

  const procSidGroups   = useProceduresStore((s) => s.sidGroups)
  const procStarGroups  = useProceduresStore((s) => s.starGroups)
  const procAppchGroups = useProceduresStore((s) => s.appchGroups)
  const procVisible     = useProceduresStore((s) => s.visible)

  const centerlines     = useRunwaysStore((s) => s.centerlines)
  const cltrVisible     = useRunwaysStore((s) => s.cltrVisible)
  const satBuckets      = useRunwaysStore((s) => s.satBuckets)
  const facilityAirbase = useRunwaysStore((s) => s.facilityAirbase)

  const facilityCenterlines = useMemo(
    () => facilityAirbase ? centerlines.filter((c) => c.airbase === facilityAirbase) : [],
    [centerlines, facilityAirbase],
  )

  const colors = profile?.dcb ?? DEFAULT_DCB

  // ── Resolve current slot list ──────────────────────────────────────
  const slots = useMemo(() => {
    if (menuKey === 'main') {
      if (mvaSlot == null) return MAIN_BUTTONS
      // Pin MVA to its fixed slot index from the store (derived from ICAO_PRESETS).
      return MAIN_BUTTONS.map((slot) => {
        if (slot.slotType !== 'halfV') return slot
        return { ...slot, buttons: slot.buttons.map((b) =>
          MAP_SLOT_KEYS[b.id] === mvaSlot ? { id: 'MVA', lines: ['MVA'], type: 'toggle' } : b) }
      })
    }
    if (menuKey === 'aux')  return AUX_BUTTONS
    if (menuKey === 'maps') {
      const staticSlots = SUBMENU_DEFS.maps.buttons
        .filter((b) => b.id !== 'DONE')

      // Pool RELIEF + GEO with overflow map categories and pair them sequentially
      const halfPool = [
        { id: 'RELIEF', lines: ['RELIEF'], type: 'toggle' },
        { id: 'GEO',    lines: ['GEO'],    type: 'toggle' },
        { id: 'FIXES',  lines: ['FIXES'],  type: 'toggle' },
      ]
      for (let i = 5; i < maps.length; i++) {
        if (maps[i] != null) halfPool.push({ id: `MAP_OVF_${i}`, mapKey: i, lines: [], type: 'toggle' })
      }
      const overflowSlots = []
      for (let i = 0; i < halfPool.length; i += 2) {
        const top = halfPool[i]
        const bot = halfPool[i + 1] ?? null
        overflowSlots.push({ id: `slot_ovf_${i}`, slotType: 'halfV', buttons: bot ? [top, bot] : [top] })
      }

      // Individual halfV buttons for facility centerlines only
      const cltrPairs = []
      for (let i = 0; i < facilityCenterlines.length; i += 2) {
        const cl0 = facilityCenterlines[i]
        const cl1 = facilityCenterlines[i + 1]
        const top = { id: `CLTR_${cl0.id}`, lines: [cl0.label], type: 'toggle' }
        const bot = cl1 ? { id: `CLTR_${cl1.id}`, lines: [cl1.label], type: 'toggle' } : null
        cltrPairs.push({ id: `slot_cltr_${i}`, slotType: 'halfV', buttons: bot ? [top, bot] : [top] })
      }

      // One halfV slot for satellite flow buckets (SAT NW / SAT SE)
      const satSlots = []
      if (satBuckets.length > 0) {
        const satBtns = satBuckets.map((b) => ({ id: `SAT_${b.label}`, lines: [`SAT ${b.label}`], type: 'toggle' }))
        satSlots.push({ id: 'slot_sat', slotType: 'halfV', buttons: satBtns })
      }

      // Procedure buttons — SIDs, STARs, then approaches, paired into halfV slots
      const procBtns = []
      for (const groupKey of Object.keys(procSidGroups).sort()) {
        const lastSpace = groupKey.lastIndexOf(' ')
        const lines = lastSpace >= 0 ? [groupKey.slice(0, lastSpace), groupKey.slice(lastSpace + 1)] : [groupKey]
        procBtns.push({ id: `PROC_SID_${groupKey}`, lines, type: 'toggle' })
      }
      for (const groupKey of Object.keys(procStarGroups).sort()) {
        const lastSpace = groupKey.lastIndexOf(' ')
        const lines = lastSpace >= 0 ? [groupKey.slice(0, lastSpace), groupKey.slice(lastSpace + 1)] : [groupKey]
        procBtns.push({ id: `PROC_STAR_${groupKey}`, lines, type: 'toggle' })
      }
      for (const groupKey of Object.keys(procAppchGroups).sort()) {
        const lastSpace = groupKey.lastIndexOf(' ')
        const lines = lastSpace >= 0 ? [groupKey.slice(0, lastSpace), groupKey.slice(lastSpace + 1)] : [groupKey]
        procBtns.push({ id: `PROC_APPCH_${groupKey}`, lines, type: 'toggle' })
      }
      const procSlots = []
      for (let i = 0; i < procBtns.length; i += 2) {
        const top = procBtns[i]
        const bot = procBtns[i + 1] ?? null
        procSlots.push({ id: `_proc_hv_${i}`, slotType: 'halfV', buttons: bot ? [top, bot] : [top] })
      }

      return [...staticSlots, ...overflowSlots, ...cltrPairs, ...satSlots, ...procSlots, { id: 'DONE', lines: ['DONE'], type: 'done' }]
    }
    return SUBMENU_DEFS[menuKey]?.buttons ?? MAIN_BUTTONS
  }, [menuKey, maps, facilityCenterlines, satBuckets, procSidGroups, procStarGroups, procAppchGroups, mvaSlot])

  // ── Button click ───────────────────────────────────────────────────
  const handleButtonClick = useCallback((btn) => {
    switch (btn.type) {
      case 'spacer': return

      case 'shift':
        setMenuKey(k => k === 'aux' ? 'main' : 'aux')
        updateWindow(WINDOW_ID, { dcbActiveSpinner: null })
        return

      case 'done': {
        const parent = SUBMENU_DEFS[menuKey]?.parent ?? 'main'
        setMenuKey(parent)
        updateWindow(WINDOW_ID, { dcbActiveSpinner: null })
        usePresetsStore.getState().setPendingMode(null)
        usePreviewStore.getState().clearResponse()
        return
      }

      case 'submenu':
        setMenuKey(btn.target)
        updateWindow(WINDOW_ID, { dcbActiveSpinner: null })
        return

      case 'toggle': {
        const mapKey = mapKeyOf(btn)
        if (mapKey != null) {
          useMapsStore.getState().toggleMap(mapKey)
        } else if (btn.id === 'HOLDS') {
          useHoldingsStore.getState().toggleVisible()
        } else if (btn.id === 'MSA') {
          useMsaStore.getState().toggleVisible()
        } else if (btn.id === 'MORA') {
          useMoraStore.getState().toggleVisible()
        } else if (btn.id === 'RELIEF') {
          useReliefStore.getState().toggleVisible()
        } else if (btn.id === 'GEO') {
          useGeoStore.getState().toggleVisible()
        } else if (btn.id === 'FIXES') {
          useFixesStore.getState().toggleVisible()
        } else if (btn.id === 'MVA') {
          useMvaStore.getState().toggleVisible()
        } else if (btn.id === 'AIR_V') {
          useAirwaysStore.getState().toggleVisible('V')
        } else if (btn.id === 'AIR_J') {
          useAirwaysStore.getState().toggleVisible('J')
        } else if (btn.id === 'AIR_B') {
          useAirwaysStore.getState().toggleVisible('B')
        } else if (btn.id.startsWith('CLTR_')) {
          useRunwaysStore.getState().toggleCenterline(btn.id.slice(5))
        } else if (btn.id.startsWith('SAT_')) {
          useRunwaysStore.getState().toggleSatBucket(btn.id.slice(4))
        } else if (btn.id.startsWith('PROC_SID_')) {
          useProceduresStore.getState().toggleVisible(`SID:${btn.id.slice(9)}`)
        } else if (btn.id.startsWith('PROC_STAR_')) {
          useProceduresStore.getState().toggleVisible(`STAR:${btn.id.slice(10)}`)
        } else if (btn.id.startsWith('PROC_APPCH_')) {
          useProceduresStore.getState().toggleVisible(`APPCH:${btn.id.slice(11)}`)
        } else if (btn.id === 'CA') {
          const next = !(windowSettings?.stcaEnabled ?? false)
          updateWindow(WINDOW_ID, { stcaEnabled: next })
          saveStarsPrefs({ stcaEnabled: next })
        } else if (btn.id === 'WNG') {
          const next = !(windowSettings?.simWingmenStandby ?? false)
          updateWindow(WINDOW_ID, { simWingmenStandby: next })
          saveStarsPrefs({ simWingmenStandby: next })
        }
        return
      }

      case 'preset-slot': {
        const idx     = parseInt(btn.id.replace('PRESET_', ''), 10)
        const pending = usePresetsStore.getState().pendingMode
        if (pending?.type === 'pick') {
          usePresetsStore.getState().setPendingMode({ type: 'name', slotIndex: idx })
          usePreviewStore.getState().clear()
          usePreviewStore.getState().setResponse('ENTER NAME:')
        } else if (pending?.type === 'delete') {
          usePresetsStore.getState().deleteSlot(idx)
          usePreviewStore.getState().clearResponse()
        } else {
          // Load the preset
          const slot = usePresetsStore.getState().slots[idx]
          if (slot) {
            updateWindow(WINDOW_ID, {
              ...slot.settings,
              offCntr:         false,
              rrCenterLat:     null,
              rrCenterLng:     null,
              rrOffCenter:     false,
              pendingAction:   null,
              dcbActiveSpinner: null,
            })
            const s = slot.settings
            applyLayerVisibility(s)
            usePresetsStore.getState().setActiveSlot(idx)
          }
        }
        return
      }

      case 'action':
        if (btn.id === 'OFF_CNTR' && windowSettings?.offCntr) {
          recenterScope(WINDOW_ID)
        } else if (btn.id === 'PLACE_CNTR') {
          const already = windowSettings?.pendingAction === 'PLACE_CNTR'
          updateWindow(WINDOW_ID, { pendingAction: already ? null : 'PLACE_CNTR' })
        } else if (btn.id === 'PLACE_RR') {
          const already = windowSettings?.pendingAction === 'PLACE_RR'
          updateWindow(WINDOW_ID, { pendingAction: already ? null : 'PLACE_RR' })
        } else if (btn.id === 'PTL_OWN') {
          const cur = useDisplayStore.getState().windows[WINDOW_ID]?.ptlMode
          updateWindow(WINDOW_ID, { ptlMode: cur === 'OWN' ? null : 'OWN' })
        } else if (btn.id === 'PTL_ALL') {
          const cur = useDisplayStore.getState().windows[WINDOW_ID]?.ptlMode
          updateWindow(WINDOW_ID, { ptlMode: cur === 'ALL' ? null : 'ALL' })
        } else if (btn.id === 'DCB_TOP') {
          updateWindow(WINDOW_ID, { dcbPosition: 'top' })
        } else if (btn.id === 'DCB_BOTTOM') {
          updateWindow(WINDOW_ID, { dcbPosition: 'bottom' })
        } else if (btn.id === 'DCB_LEFT') {
          updateWindow(WINDOW_ID, { dcbPosition: 'left' })
        } else if (btn.id === 'DCB_RIGHT') {
          updateWindow(WINDOW_ID, { dcbPosition: 'right' })
        } else if (btn.id === 'PREF_SAVE') {
          const win      = useDisplayStore.getState().windows[WINDOW_ID]
          const enriched = {
            ...win,
            ...snapshotLayerVisibility(),
          }
          const saved = usePresetsStore.getState().saveActive(enriched)
          usePreviewStore.getState().setResponse(saved ? 'PREF SAVED' : 'NO PRESET LOADED')
        } else if (btn.id === 'PREF_SAVE_AS') {
          usePresetsStore.getState().setPendingMode({ type: 'pick' })
          usePreviewStore.getState().setResponse('SELECT SLOT')
        } else if (btn.id === 'PREF_DELETE') {
          usePresetsStore.getState().setPendingMode({ type: 'delete' })
          usePreviewStore.getState().setResponse('SELECT SLOT TO DELETE')
        } else if (btn.id === 'PREF_DEFAULT') {
          const { activeSlot } = usePresetsStore.getState()
          if (activeSlot === null) {
            usePreviewStore.getState().setResponse('NO PRESET LOADED')
          } else {
            usePresetsStore.getState().setDefaultSlot(activeSlot)
          }
        } else if (btn.id === 'RR_CNTR' && windowSettings?.rrOffCenter) {
          updateWindow(WINDOW_ID, {
            rrCenterLat:   null,
            rrCenterLng:   null,
            rrOffCenter:   false,
            pendingAction: null,
          })
        }
        return

      default: {
        const cur = windowSettings?.dcbActiveSpinner ?? null
        updateWindow(WINDOW_ID, { dcbActiveSpinner: cur === btn.id ? null : btn.id })
        return
      }
    }
  }, [menuKey, updateWindow, windowSettings])

  // ── Wheel — adjust active value button, or scroll DCB if overflowing ────
  const handleWheel = useCallback((e) => {
    if (activeButton) {
      e.preventDefault()
      e.stopPropagation()
      const dir = wheelDir(e)
      if (dir === null) return
      applyValueDelta(activeButton, dir, windowSettings, updateWindow)
      return
    }
    const pos = windowSettings?.dcbPosition ?? 'top'
    if ((pos === 'top' || pos === 'bottom') && barRef.current) {
      const bar = barRef.current
      if (bar.scrollWidth > bar.clientWidth) {
        e.preventDefault()
        bar.scrollLeft += e.deltaY
      }
    }
  }, [activeButton, windowSettings, updateWindow, wheelDir])

  useNonPassiveWheel(barRef, handleWheel)

  // ── Render a single button def ────────────────────────────────────
  function renderBtn(btn, half = false) {
    // Resolve preset-slot display before anything else
    let displayBtn = btn

    const mapKey = mapKeyOf(btn)
    if (mapKey != null) {
      const label = typeof mapKey === 'number' ? (maps[mapKey]?.name ?? '') : 'LBL'
      const lines = label.startsWith('ADJ ') ? ['ADJ', label.slice(4)] : [label]
      displayBtn = { ...btn, lines }
    }

    if (btn.type === 'preset-slot') {
      const idx  = parseInt(btn.id.replace('PRESET_', ''), 10)
      const slot = presetSlots[idx]
      displayBtn = { ...btn, lines: slot ? [slot.name] : [`P${idx + 1}`] }
    }

    const isActive  = activeButton === displayBtn.id
    let   isToggled = mapKey != null
      ? (mapsVisible[mapKey] ?? false)
      : btn.id === 'HOLDS'
        ? holdsVisible
        : btn.id === 'MSA'
          ? msaVisible
          : btn.id === 'MORA'
            ? moraVisible
            : btn.id === 'RELIEF'
              ? reliefVisible
            : btn.id === 'GEO'
              ? geoVisible
            : btn.id === 'FIXES'
              ? fixesVisible
            : btn.id === 'MVA'
              ? mvaVisible
            : btn.id === 'AIR_V'
              ? airwaysVisible.V
              : btn.id === 'AIR_J'
                ? airwaysVisible.J
                : btn.id === 'AIR_B'
                  ? airwaysVisible.B
                  : btn.id.startsWith('CLTR_')
          ? (cltrVisible[btn.id.slice(5)] ?? false)
          : btn.id.startsWith('SAT_')
            ? (() => {
                const label  = btn.id.slice(4)
                const bucket = satBuckets.find((b) => b.label === label)
                return bucket ? bucket.ids.some((id) => cltrVisible[id]) : false
              })()
            : btn.id.startsWith('PROC_SID_')
              ? procVisible.has(`SID:${btn.id.slice(9)}`)
              : btn.id.startsWith('PROC_STAR_')
                ? procVisible.has(`STAR:${btn.id.slice(10)}`)
                : btn.id.startsWith('PROC_APPCH_')
                  ? procVisible.has(`APPCH:${btn.id.slice(11)}`)
                  : btn.id === 'CA'
                    ? (windowSettings?.stcaEnabled ?? false)
                    : btn.id === 'WNG'
                      ? (windowSettings?.simWingmenStandby ?? false)
                      : false

    if (btn.id === 'OFF_CNTR') {
      isToggled = windowSettings?.offCntr ?? false
    }
    if (btn.id === 'PLACE_RR' || btn.id === 'PLACE_CNTR') {
      isToggled = windowSettings?.pendingAction === btn.id
    }
    if (btn.id === 'RR_CNTR') {
      isToggled = windowSettings?.rrOffCenter ?? false
    }
    if (['DCB_TOP', 'DCB_BOTTOM', 'DCB_LEFT', 'DCB_RIGHT'].includes(btn.id)) {
      const posMap = { DCB_TOP: 'top', DCB_BOTTOM: 'bottom', DCB_LEFT: 'left', DCB_RIGHT: 'right' }
      isToggled = (windowSettings?.dcbPosition ?? 'top') === posMap[btn.id]
    }
    if (btn.id === 'PTL_OWN') {
      isToggled = windowSettings?.ptlMode === 'OWN'
    }
    if (btn.id === 'PTL_ALL') {
      isToggled = windowSettings?.ptlMode === 'ALL'
    }
    if (btn.type === 'preset-slot') {
      const idx = parseInt(btn.id.replace('PRESET_', ''), 10)
      isToggled = activePreset === idx
    }
    if (btn.id === 'PREF_SAVE_AS') {
      isToggled = presetPending?.type === 'pick' || presetPending?.type === 'name'
    }
    if (btn.id === 'PREF_DELETE') {
      isToggled = presetPending?.type === 'delete'
    }
    if (btn.id === 'PREF_DEFAULT') {
      isToggled = activePreset !== null && activePreset === defaultPreset
    }

    const rawVal = (displayBtn.type === 'value') ? getWindowValue(displayBtn.id, windowSettings) : null
    const valStr = rawVal != null ? VALUE_CONFIG[displayBtn.id]?.fmt(rawVal, unitSystem) : null

    return (
      <DcbButton
        key={btn.id}
        btn={displayBtn}
        isActive={isActive}
        isToggled={isToggled}
        valStr={valStr}
        colors={colors}
        half={half}
        onClick={() => handleButtonClick(btn)}
      />
    )
  }

  return (
    <div
      ref={barRef}
      className="dcb-bar"
      data-pos={windowSettings?.dcbPosition ?? 'top'}
      style={{
        background: colors.background,
        borderBottomColor: colors.buttonBorder,
        opacity: briteDcb ?? 1,
        fontSize: `${10 + (csDcb ?? 3) * 2}px`,
      }}
    >
      {slots.map((slot) => {
        if (slot.slotType === 'halfV') {
          return (
            <div key={slot.id} className="dcb-halfV">
              {slot.buttons.map(btn => renderBtn(btn, true))}
            </div>
          )
        }
        return renderBtn(slot)
      })}
    </div>
  )
}
