// A METAR for one airfield, built from the DCS exporter's weather (see
// utils/liveWeather.js). DCS has no METAR of its own, so parts of it are
// rough by necessity:
// - Clouds come from the mission's cloud preset as DCS defines it, shifted by
//   the mission's cloud base (the editor's base slider starts at the
//   preset's first layer), coverage 0..1 read as eighths.
// - Dew point isn't modelled at all; it's worked back from the cloud-base
//   rule of thumb (base above ground ~ 125 m per degree of spread) on the
//   lowest cloud layer, or the mission's cloud base when there are no clouds.
// - Visibility is the least of the mission's visibility, dust and fog.
// Wind is true, as in any METAR. US-style fields (K/P ICAO) report statute
// miles and inches of mercury, the rest metres and hPa.

const M_TO_FT = 3.28084
const MS_TO_KT = 1.94384
const M_PER_SM = 1609.344
const HPA_TO_INHG = 0.0295299830714
// Cloud base above ground (m) per degree C of temperature/dew point spread.
const BASE_M_PER_DEG = 125

const pad = (n, len) => String(n).padStart(len, '0')

function isUsStyle(icao) {
  return /^[KP]/.test(icao)
}

function windGroup(wind) {
  if (!wind || typeof wind.speedMs !== 'number') return '/////KT'
  const kt = Math.round(wind.speedMs * MS_TO_KT)
  if (kt === 0) return '00000KT'
  let dir = Math.round(wind.fromDeg / 10) * 10
  if (dir === 0) dir = 360
  return `${pad(dir, 3)}${pad(kt, 2)}KT`
}

// The fog that's in effect: live values when the hook sent them, else the
// mission's own (legacy enable_fog/fog), as { visibility, thickness } in m.
function activeFog(weather) {
  const live = weather?.fog
  if (live && typeof live.visibility === 'number' && typeof live.thickness === 'number') {
    return live.thickness > 0 && live.visibility > 0 ? live : null
  }
  const m = weather?.mission
  if (m?.enable_fog && m.fog?.thickness > 0 && m.fog?.visibility > 0) return m.fog
  return null
}

// { meters, fog, dust }: the visibility and whether fog or dust sets it.
function visibility(weather) {
  const m = weather?.mission ?? {}
  let meters = typeof m.visibility?.distance === 'number' ? m.visibility.distance : 10000
  let fog = false
  let dust = false
  if (m.enable_dust && m.dust_density > 0 && m.dust_density < meters) {
    meters = m.dust_density
    dust = true
  }
  const f = activeFog(weather)
  if (f && f.visibility < meters) {
    meters = f.visibility
    fog = true
    dust = false
  }
  return { meters, fog, dust }
}

function visibilityGroup(meters, usStyle) {
  if (usStyle) {
    const sm = meters / M_PER_SM
    if (sm >= 10) return '10SM'
    if (sm >= 1) return `${Math.floor(sm)}SM`
    if (sm >= 0.75) return '3/4SM'
    if (sm >= 0.5) return '1/2SM'
    if (sm >= 0.25) return '1/4SM'
    return 'M1/4SM'
  }
  if (meters >= 10000) return '9999'
  const step = meters < 800 ? 50 : meters < 5000 ? 100 : 1000
  return pad(Math.floor(meters / step) * step, 4)
}

// Cloud layers as [{ baseM (MSL), oktas }], lowest first.
function cloudLayers(weather) {
  const clouds = weather?.mission?.clouds
  if (!clouds) return []
  const preset = weather.cloudPreset
  if (clouds.preset && preset?.layers?.length) {
    const shift = typeof clouds.base === 'number' ? clouds.base - preset.layers[0].altitudeMin : 0
    return preset.layers
      .map((l) => ({ baseM: l.altitudeMin + shift, oktas: Math.min(8, Math.round((l.coverage ?? 0) * 8)) }))
      .filter((l) => l.oktas > 0)
      .sort((a, b) => a.baseM - b.baseM)
  }
  // Older missions: one layer with a 0-10 density.
  const oktas = Math.min(8, Math.round((clouds.density ?? 0) * 0.8))
  return oktas > 0 && typeof clouds.base === 'number' ? [{ baseM: clouds.base, oktas }] : []
}

const COVER = (oktas) => (oktas <= 2 ? 'FEW' : oktas <= 4 ? 'SCT' : oktas <= 7 ? 'BKN' : 'OVC')

// Height above the field in hundreds of feet, to the steps METARs report.
function heightGroup(aglM) {
  const ft = Math.max(0, aglM * M_TO_FT)
  const step = ft <= 5000 ? 100 : ft <= 10000 ? 500 : 1000
  return pad(Math.round(ft / step) * step / 100, 3)
}

function precipitation(weather, tempC) {
  const power = weather?.cloudPreset?.precipitationPower
  if (weather?.mission?.clouds?.preset) {
    if (!(power > 0)) return null
    return tempC != null && tempC <= 0 ? 'SN' : 'RA'
  }
  switch (weather?.mission?.clouds?.iprecptns) {
    case 1: return 'RA'
    case 2: return 'TSRA'
    case 3: return 'SN'
    case 4: return '+SN'
    default: return null
  }
}

const tempGroup = (c) => (c < 0 ? `M${pad(-c, 2)}` : pad(c, 2))

// The METAR text, or null without the airfield's live sample. utc:
// { day, h, m } of the observation time.
export function buildMetar({ icao, airfield, weather, utc }) {
  if (!airfield) return null
  const usStyle = isUsStyle(icao)
  const elevM = airfield.elevationM ?? 0
  const parts = ['METAR', icao]
  if (utc) parts.push(`${pad(utc.day, 2)}${pad(utc.h, 2)}${pad(utc.m, 2)}Z`)
  parts.push(windGroup(airfield.wind))

  const vis = visibility(weather)
  parts.push(visibilityGroup(vis.meters, usStyle))

  const tempC = typeof airfield.tempC === 'number' ? Math.round(airfield.tempC) : null
  const wx = []
  const precip = precipitation(weather, tempC)
  if (precip) wx.push(precip)
  if (vis.fog) wx.push(vis.meters < 1000 ? 'FG' : 'BR')
  else if (vis.dust && vis.meters < 5000) wx.push('DU')
  parts.push(...wx)

  const layers = cloudLayers(weather)
  if (layers.length) {
    for (const l of layers) parts.push(`${COVER(l.oktas)}${heightGroup(l.baseM - elevM)}`)
  } else {
    parts.push(usStyle ? 'CLR' : 'NSC')
  }

  if (tempC != null) {
    const meBase = weather?.mission?.clouds?.base
    const baseAglM = layers.length ? layers[0].baseM - elevM : typeof meBase === 'number' ? meBase - elevM : null
    let dew = baseAglM != null ? Math.round(airfield.tempC - Math.max(0, baseAglM) / BASE_M_PER_DEG) : null
    if (vis.fog && vis.meters < 1000) dew = tempC
    if (dew != null && dew > tempC) dew = tempC
    parts.push(`${tempGroup(tempC)}/${dew != null ? tempGroup(dew) : ''}`)
  }

  if (typeof airfield.qnhHpa === 'number') {
    parts.push(usStyle
      ? `A${pad(Math.round(airfield.qnhHpa * HPA_TO_INHG * 100), 4)}`
      : `Q${pad(Math.round(airfield.qnhHpa), 4)}`)
  }
  return parts.join(' ')
}
