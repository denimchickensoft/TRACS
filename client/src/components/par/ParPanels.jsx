import { D2R, NM_TO_FEET, PAR_MAX_ELEV, PAR_AZ_HALF, GS_TOL_DEG, AZ_TOL_DEG } from './parConstants.js'

export function ElevationPanel({ contacts, config, width, height, mode, mirrored }) {
  const { rangeNm, gsAngle, vertTol, tch = 0 } = config
  const M = { t: 14, b: 22, l: 42, r: 10 }
  const W = width  - M.l - M.r
  const H = height - M.t - M.b

  // Altitude at far range for glideslope (includes TCH offset) and service volume ceiling
  const gsEndAlt  = rangeNm * NM_TO_FEET * Math.tan(gsAngle * D2R) + tch
  const svCeilAlt = rangeNm * NM_TO_FEET * Math.tan(PAR_MAX_ELEV * D2R) + tch

  // Round display max up to a clean tick boundary
  const altStep = svCeilAlt <= 2000 ? 250 : svCeilAlt <= 6000 ? 500 : 1000
  const maxAlt  = Math.ceil(svCeilAlt / altStep) * altStep

  // x: threshold at right (standard) or left (mirrored); far range is the opposite end
  const xr = mirrored
    ? (r) => M.l + (r / rangeNm) * W
    : (r) => M.l + (1 - r / rangeNm) * W
  // y: altitude 0 = bottom of plot; maxAlt = top (y decreases as altitude increases)
  const ya = (alt) => M.t + H * (1 - alt / maxAlt)

  // Label anchors that follow the threshold end vs the far end
  const thrX      = mirrored ? M.l + 4   : M.l + W - 2
  const thrAnchor = mirrored ? 'start'   : 'end'
  const farX      = mirrored ? M.l + W - 2 : M.l + 4
  const farAnchor = mirrored ? 'end'     : 'start'
  const tolOffset = mirrored ? 2         : -2
  const tolAnchor = mirrored ? 'start'   : 'end'

  const rTickStep = rangeNm <= 5 ? 1 : rangeNm <= 12 ? 2 : 5
  const rTicks    = []
  const aTicks    = []
  for (let r = 0; r <= rangeNm; r += rTickStep) rTicks.push(r)
  for (let a = 0; a <= maxAlt; a += altStep) aTicks.push(a)

  // Tolerance corridor: triangle that tapers to TCH point at the threshold.
  const tolPoly = [
    `${xr(0)},${ya(tch)}`,
    `${xr(rangeNm)},${ya(gsEndAlt + vertTol)}`,
    `${xr(rangeNm)},${ya(gsEndAlt - vertTol)}`,
  ].join(' ')

  return (
    <svg width={width} height={height} style={{ display: 'block' }}
      fontFamily="Roboto Mono, monospace">
      <defs>
        <clipPath id="par-el-clip">
          <rect x={M.l} y={M.t} width={W} height={H} />
        </clipPath>
      </defs>

      {/* Background */}
      <rect width={width} height={height} fill="#060606" />
      <rect x={M.l} y={M.t} width={W} height={H} fill="#0d0d0d" />

      <g clipPath="url(#par-el-clip)">
        {/* Altitude grid lines (horizontal) */}
        {aTicks.map((a) => (
          <line key={a}
            x1={M.l} y1={ya(a)} x2={M.l + W} y2={ya(a)}
            stroke={a === 0 ? '#1c1c1c' : '#161616'} strokeWidth={1}
          />
        ))}

        {/* Range grid lines (vertical) */}
        {rTicks.map((r) => (
          <line key={r}
            x1={xr(r)} y1={M.t} x2={xr(r)} y2={M.t + H}
            stroke="#161616" strokeWidth={1}
          />
        ))}

        {/* Service volume upper bound — 8° diagonal from threshold */}
        <line
          x1={xr(0)}       y1={ya(tch)}
          x2={xr(rangeNm)} y2={ya(svCeilAlt)}
          stroke="#1a3a1a" strokeWidth={1} strokeDasharray="9 5"
        />

        {/* Tolerance corridor — parallelogram around glideslope */}
        <polygon points={tolPoly} fill="rgba(0,75,0,0.22)" stroke="none" />

        {/* Tolerance upper edge — converges to TCH at threshold */}
        <line
          x1={xr(0)}       y1={ya(tch)}
          x2={xr(rangeNm)} y2={ya(gsEndAlt + vertTol)}
          stroke="#235a23" strokeWidth={1} strokeDasharray="5 3"
        />
        {/* Tolerance lower edge — converges to TCH at threshold */}
        <line
          x1={xr(0)}       y1={ya(tch)}
          x2={xr(rangeNm)} y2={ya(gsEndAlt - vertTol)}
          stroke="#235a23" strokeWidth={1} strokeDasharray="5 3"
        />

        {/* CASE III — 1200 ft minimum descent altitude (carrier only) */}
        {mode === 'carrier' && (() => {
          const interceptRange = 1200 / (NM_TO_FEET * Math.tan(gsAngle * D2R))
          return (
            <line
              x1={xr(rangeNm)}      y1={ya(1200)}
              x2={xr(interceptRange)} y2={ya(1200)}
              stroke="#5a4a10" strokeWidth={1} strokeDasharray="8 4"
            />
          )
        })()}

        {/* Ideal glideslope — crosses threshold at TCH */}
        <line
          x1={xr(0)}       y1={ya(tch)}
          x2={xr(rangeNm)} y2={ya(gsEndAlt)}
          stroke="#2a7a2a" strokeWidth={2}
        />

        {/* Tolerance band label at the far-range edge */}
        <text x={xr(rangeNm) + tolOffset} y={ya(gsEndAlt + vertTol) - 2}
          textAnchor={tolAnchor} fontSize={9} fill="#235a23">
          +{GS_TOL_DEG}°
        </text>
        <text x={xr(rangeNm) + tolOffset} y={ya(gsEndAlt - vertTol) + 9}
          textAnchor={tolAnchor} fontSize={9} fill="#235a23">
          -{GS_TOL_DEG}°
        </text>

        {/* Contacts — shown at actual (range, altitude AGL) */}
        {contacts.map((c) => {
          const x        = xr(c.rangeFinal)
          const y        = ya(c.altAgl)
          const tolAtRng = vertTol * (c.rangeFinal / rangeNm)
          const inTol    = Math.abs(c.vertDev) <= tolAtRng
          const color    = inTol ? (mode === 'carrier' ? '#FFD700' : '#4db8ff') : '#ffaa22'
          return (
            <g key={c.id}>
              <circle cx={x} cy={y} r={4} fill={color} />
              <text x={x} y={y - 7} fontSize={9} fill={color} textAnchor="middle">{c.label}</text>
            </g>
          )
        })}
      </g>

      {/* Plot border */}
      <rect x={M.l} y={M.t} width={W} height={H}
        fill="none" stroke="#1e1e1e" strokeWidth={1} />

      {/* Altitude axis labels (left of plot) */}
      {aTicks.map((a) => (
        <text key={a} x={M.l - 4} y={ya(a) + 3}
          textAnchor="end" fontSize={9}
          fill={a === 0 ? '#2a2a2a' : '#383838'}>
          {a === 0 ? '0' : a >= 1000 ? `${a / 1000}k` : a}
        </text>
      ))}

      {/* Glideslope angle label — left Y-axis at the far-range GS altitude */}
      <text x={M.l - 4} y={ya(gsEndAlt) + 3}
        textAnchor="end" fontSize={9} fill="#2a6a2a">
        {gsAngle.toFixed(1)}°
      </text>


      {/* Range tick labels (bottom) */}
      {rTicks.map((r) => (
        <text key={r} x={xr(r)} y={height - 5}
          textAnchor="middle" fontSize={9} fill="#343434">{r}</text>
      ))}

      {/* Panel identifier (far end) and threshold marker */}
      <text x={farX} y={M.t + 11} textAnchor={farAnchor} fontSize={9} fill="#2c2c2c" letterSpacing={1}>EL</text>
      <text x={thrX} y={M.t + 11} textAnchor={thrAnchor} fontSize={9} fill="#2c2c2c">THR</text>
    </svg>
  )
}

// ── AzimuthPanel ──────────────────────────────────────────────────────────────
// Top-down view of the approach. X-axis = range (far out = left, threshold = right).
// Y-axis = lateral deviation from centerline. lateralDev is always +right from the pilot's
// perspective, which is geographically +south for eastern approaches and +north for western.
// yl() flips sign when mirrored so that right-of-CL always appears below center on screen
// (i.e., the display is consistent regardless of approach direction).
// The PAR's ±10° azimuth coverage forms a V-cone from the threshold point outward.

export function AzimuthPanel({ contacts, config, width, height, mode, mirrored }) {
  const { rangeNm, latTol } = config
  const M  = { t: 14, b: 22, l: 42, r: 10 }
  const W  = width  - M.l - M.r
  const H  = height - M.t - M.b
  const cy = M.t + H / 2

  // Service volume half-width at the far range (NM)
  const coneHalfNm = rangeNm * Math.tan(PAR_AZ_HALF * D2R)
  // Display range is slightly wider than the cone so the boundaries are visible
  const displayLat = Math.max(latTol * 2.5, coneHalfNm * 1.15)

  const xr = mirrored
    ? (r) => M.l + (r / rangeNm) * W
    : (r) => M.l + (1 - r / rangeNm) * W
  const yl = mirrored
    ? (lat) => cy - (lat / displayLat) * (H / 2)
    : (lat) => cy + (lat / displayLat) * (H / 2)

  const thrX      = mirrored ? M.l + 4   : M.l + W - 2
  const thrAnchor = mirrored ? 'start'   : 'end'
  const farX      = mirrored ? M.l + W - 2 : M.l + 4
  const farAnchor = mirrored ? 'end'     : 'start'

  const rTickStep = rangeNm <= 5 ? 1 : rangeNm <= 12 ? 2 : 5
  const rTicks    = []
  for (let r = 0; r <= rangeNm; r += rTickStep) rTicks.push(r)

  // Cone origin: threshold = right-center of the plot area
  const coneOX = xr(0)
  const coneOY = yl(0)

  return (
    <svg width={width} height={height} style={{ display: 'block' }}
      fontFamily="Roboto Mono, monospace">
      <defs>
        <clipPath id="par-az-clip">
          <rect x={M.l} y={M.t} width={W} height={H} />
        </clipPath>
      </defs>

      {/* Background */}
      <rect width={width} height={height} fill="#060606" />
      <rect x={M.l} y={M.t} width={W} height={H} fill="#0d0d0d" />

      <g clipPath="url(#par-az-clip)">
        {/* Range grid lines */}
        {rTicks.map((r) => (
          <line key={r}
            x1={xr(r)} y1={M.t} x2={xr(r)} y2={M.t + H}
            stroke="#161616" strokeWidth={1}
          />
        ))}

        {/* Service volume cone — V opening from threshold outward */}
        <line
          x1={coneOX} y1={coneOY}
          x2={xr(rangeNm)} y2={yl(-coneHalfNm)}
          stroke="#1a3a1a" strokeWidth={1} strokeDasharray="9 5"
        />
        <line
          x1={coneOX} y1={coneOY}
          x2={xr(rangeNm)} y2={yl(coneHalfNm)}
          stroke="#1a3a1a" strokeWidth={1} strokeDasharray="9 5"
        />

        {/* Tolerance corridor — triangle tapering to threshold (angular tolerance) */}
        <polygon
          points={[
            `${coneOX},${coneOY}`,
            `${xr(rangeNm)},${yl(-latTol)}`,
            `${xr(rangeNm)},${yl( latTol)}`,
          ].join(' ')}
          fill="rgba(0,75,0,0.22)"
        />

        {/* Centerline */}
        <line x1={coneOX} y1={coneOY} x2={xr(rangeNm)} y2={yl(0)}
          stroke="#2a7a2a" strokeWidth={1} />

        {/* Tolerance edges — converge to threshold point */}
        <line x1={coneOX} y1={coneOY} x2={xr(rangeNm)} y2={yl(-latTol)}
          stroke="#235a23" strokeWidth={1} strokeDasharray="5 3" />
        <line x1={coneOX} y1={coneOY} x2={xr(rangeNm)} y2={yl( latTol)}
          stroke="#235a23" strokeWidth={1} strokeDasharray="5 3" />

        {/* Contacts — shown at actual (range, lateral deviation) */}
        {contacts.map((c) => {
          const x        = xr(c.rangeFinal)
          const y        = yl(c.lateralDev)
          const tolAtRng = latTol * (c.rangeFinal / rangeNm)
          const inTol    = Math.abs(c.lateralDev) <= tolAtRng
          const color    = inTol ? (mode === 'carrier' ? '#FFD700' : '#4db8ff') : '#ffaa22'
          return (
            <g key={c.id}>
              <circle cx={x} cy={y} r={4} fill={color} />
              <text x={x} y={y - 7} fontSize={9} fill={color} textAnchor="middle">{c.label}</text>
            </g>
          )
        })}
      </g>

      {/* Plot border */}
      <rect x={M.l} y={M.t} width={W} height={H}
        fill="none" stroke="#1e1e1e" strokeWidth={1} />

      {/* Lateral deviation axis labels (left of plot) */}
      <text x={M.l - 4} y={yl(-latTol) + 3} textAnchor="end" fontSize={9} fill="#383838">
        -{AZ_TOL_DEG}°
      </text>
      <text x={M.l - 4} y={cy + 3} textAnchor="end" fontSize={9} fill="#2a5a2a">CL</text>
      <text x={M.l - 4} y={yl( latTol) + 3} textAnchor="end" fontSize={9} fill="#383838">
        +{AZ_TOL_DEG}°
      </text>

      {/* Range tick labels (bottom) */}
      {rTicks.map((r) => (
        <text key={r} x={xr(r)} y={height - 5}
          textAnchor="middle" fontSize={9} fill="#343434">{r}</text>
      ))}

      {/* Panel identifier (far end) and threshold marker */}
      <text x={farX} y={M.t + 11} textAnchor={farAnchor} fontSize={9} fill="#2c2c2c" letterSpacing={1}>AZ</text>
      <text x={thrX} y={M.t + 11} textAnchor={thrAnchor} fontSize={9} fill="#2c2c2c">THR</text>
    </svg>
  )
}

// ── Par ───────────────────────────────────────────────────────────────────────
