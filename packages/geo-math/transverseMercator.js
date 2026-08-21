// Transverse Mercator forward/inverse — matches DCS's own per-theatre grid
// exactly (WGS84 ellipsoid + central_meridian/false_easting/false_northing/
// scale_factor from /projection_params.json).
//
// Uses the Krüger n-series (Karney 2011, "Transverse Mercator with an
// accuracy of a few nanometers" — the same method PROJ/GeographicLib use as
// their default TM engine). A naive truncated Redfearn/Snyder e²-series was
// tried first and rejected: it's only accurate within ~3-4° of the central
// meridian (standard UTM zone width), but DCS theatres span much further —
// Kola and Caucasus reach ~17-19° from their central meridian — and that
// series showed >150m round-trip error at real in-theatre points.
//
// The full Karney series goes to 6 terms for sub-nanometer geodesic
// accuracy; we only need on-screen pixel accuracy, so it's truncated to 3
// terms here. Measured against the untruncated 6-term series across every
// TRACS theatre's central meridian at up to 20° offset (worse than any real
// theatre reaches), 3 terms tops out at ~0.1mm error — the series converges
// fast (each term is ~n smaller, n≈0.00168 for WGS84) so this is nowhere
// near the naive-series failure mode above; it's cutting from "absurdly
// overkill" to "still absurdly overkill," not toward the failure boundary.

const D2R = Math.PI / 180
const R2D = 180 / Math.PI

const A_WGS84 = 6378137.0
const F_WGS84 = 1 / 298.257223563
const N_THIRD = F_WGS84 / (2 - F_WGS84)   // third flattening n

// Meridional radius A = a/(1+n)·(1 + n²/4 + n⁴/64 + n⁶/256)
const _A = A_WGS84 / (1 + N_THIRD) * (
  1 + N_THIRD ** 2 / 4 + N_THIRD ** 4 / 64 + N_THIRD ** 6 / 256
)

// Series truncated at 3 terms (see file header) — coefficient values
// themselves keep their full n⁶-order precision, only the number of j-terms
// summed in tmForward/tmInverse's loops is cut.

// Forward series coefficients α_j (n → ξ,η), Karney 2011 eq. 35
const n = N_THIRD
const ALPHA = [
  null,
  n / 2 - 2 / 3 * n ** 2 + 5 / 16 * n ** 3 + 41 / 180 * n ** 4 - 127 / 288 * n ** 5 + 7891 / 37800 * n ** 6,
  13 / 48 * n ** 2 - 3 / 5 * n ** 3 + 557 / 1440 * n ** 4 + 281 / 630 * n ** 5 - 1983433 / 1935360 * n ** 6,
  61 / 240 * n ** 3 - 103 / 140 * n ** 4 + 15061 / 26880 * n ** 5 + 167603 / 181440 * n ** 6,
]

// Inverse series coefficients β_j (ξ,η → n), Karney 2011 eq. 36
const BETA = [
  null,
  n / 2 - 2 / 3 * n ** 2 + 37 / 96 * n ** 3 - 1 / 360 * n ** 4 - 81 / 512 * n ** 5 + 96199 / 604800 * n ** 6,
  1 / 48 * n ** 2 + 1 / 15 * n ** 3 - 437 / 1440 * n ** 4 + 46 / 105 * n ** 5 - 1118711 / 3870720 * n ** 6,
  17 / 480 * n ** 3 - 37 / 840 * n ** 4 - 209 / 4480 * n ** 5 + 5569 / 90720 * n ** 6,
]

// Conformal-latitude series δ_j (χ → φ), Karney 2011 eq. 19
const DELTA = [
  null,
  2 * n - 2 / 3 * n ** 2 - 2 * n ** 3 + 116 / 45 * n ** 4 + 26 / 45 * n ** 5 - 2854 / 675 * n ** 6,
  7 / 3 * n ** 2 - 8 / 5 * n ** 3 - 227 / 45 * n ** 4 + 2704 / 315 * n ** 5 + 2323 / 945 * n ** 6,
  56 / 15 * n ** 3 - 136 / 35 * n ** 4 - 1262 / 105 * n ** 5 + 73814 / 2835 * n ** 6,
]

function sinh(x) { return Math.sinh ? Math.sinh(x) : (Math.exp(x) - Math.exp(-x)) / 2 }
function cosh(x) { return Math.cosh ? Math.cosh(x) : (Math.exp(x) + Math.exp(-x)) / 2 }
function atanh(x) { return Math.atanh ? Math.atanh(x) : 0.5 * Math.log((1 + x) / (1 - x)) }
function asinh(x) { return Math.asinh ? Math.asinh(x) : Math.log(x + Math.sqrt(x * x + 1)) }

const ECC = Math.sqrt(2 * F_WGS84 - F_WGS84 * F_WGS84)

// lat/lng (degrees) -> theatre grid meters { easting, northing }
export function tmForward(latDeg, lngDeg, params) {
  const { central_meridian, false_easting, false_northing, scale_factor } = params
  const k0   = scale_factor
  const phi  = latDeg * D2R
  const lam  = (lngDeg - central_meridian) * D2R

  const sinPhi = Math.sin(phi)
  const t  = sinh(atanh(sinPhi) - ECC * atanh(ECC * sinPhi))
  const xip  = Math.atan2(t, Math.cos(lam))
  const etap = asinh(Math.sin(lam) / Math.sqrt(t * t + Math.cos(lam) * Math.cos(lam)))

  let xi  = xip
  let eta = etap
  for (let j = 1; j <= 3; j++) {
    xi  += ALPHA[j] * Math.sin(2 * j * xip)  * cosh(2 * j * etap)
    eta += ALPHA[j] * Math.cos(2 * j * xip)  * sinh(2 * j * etap)
  }

  return {
    easting:  false_easting  + k0 * _A * eta,
    northing: false_northing + k0 * _A * xi,
  }
}

// theatre grid meters -> lat/lng (degrees)
export function tmInverse(easting, northing, params) {
  const { central_meridian, false_easting, false_northing, scale_factor } = params
  const k0 = scale_factor

  const xi  = (northing - false_northing) / (k0 * _A)
  const eta = (easting  - false_easting)  / (k0 * _A)

  let xip  = xi
  let etap = eta
  for (let j = 1; j <= 3; j++) {
    xip  -= BETA[j] * Math.sin(2 * j * xi) * cosh(2 * j * eta)
    etap -= BETA[j] * Math.cos(2 * j * xi) * sinh(2 * j * eta)
  }

  const chi = Math.asin(Math.sin(xip) / cosh(etap))
  let phi = chi
  for (let j = 1; j <= 3; j++) phi += DELTA[j] * Math.sin(2 * j * chi)

  const lam = Math.atan2(sinh(etap), Math.cos(xip))

  return {
    lat: phi * R2D,
    lng: central_meridian + lam * R2D,
  }
}
