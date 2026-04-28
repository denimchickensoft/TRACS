const toRad = (d) => d * Math.PI / 180
const toDeg = (r) => r * 180 / Math.PI

function julianDay(year, month, day) {
  if (month <= 2) { year -= 1; month += 12 }
  const A = Math.floor(year / 100)
  const B = 2 - A + Math.floor(A / 4)
  return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + B - 1524.5
}

function minsToHHMM(minutes) {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`
}

// Returns { sunrise, sunset } as "HHMM" Zulu strings, or null for polar day/night.
// lat/lng in decimal degrees, positive North/East.
export function sunTimes(lat, lng, year, month, day) {
  const jd = julianDay(year, month, day)
  const T  = (jd - 2451545.0) / 36525.0

  // Geometric mean longitude and anomaly of the sun
  const L0  = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360
  const M   = 357.52911 + T * (35999.05029 - T * 0.0001537)
  const Mrd = toRad(M)

  // Equation of center → sun's true longitude → apparent longitude
  const C      = Math.sin(Mrd) * (1.914602 - T * (0.004817 + T * 0.000014))
               + Math.sin(2 * Mrd) * (0.019993 - T * 0.000101)
               + Math.sin(3 * Mrd) * 0.000289
  const omega  = 125.04 - 1934.136 * T
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(toRad(omega))

  // Obliquity of ecliptic → sun's declination
  const eps0 = 23.0 + (26.0 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60.0) / 60.0
  const eps  = eps0 + 0.00256 * Math.cos(toRad(omega))
  const decl = toDeg(Math.asin(Math.sin(toRad(eps)) * Math.sin(toRad(lambda))))

  // Equation of time (minutes)
  const y   = Math.tan(toRad(eps / 2)) ** 2
  const ecc = 0.016708634 - T * (0.000042037 + T * 0.0000001267)
  const eqT = 4 * toDeg(
    y * Math.sin(2 * toRad(L0))
    - 2 * ecc * Math.sin(Mrd)
    + 4 * ecc * y * Math.sin(Mrd) * Math.cos(2 * toRad(L0))
    - 0.5 * y * y * Math.sin(4 * toRad(L0))
    - 1.25 * ecc * ecc * Math.sin(2 * Mrd)
  )

  // Solar noon in UTC minutes from midnight
  const solarNoon = 720 - 4 * lng - eqT

  // Hour angle at horizon (-0.8333° accounts for refraction + solar disk radius)
  const cosHA = (Math.sin(toRad(-0.8333)) - Math.sin(toRad(lat)) * Math.sin(toRad(decl)))
              / (Math.cos(toRad(lat)) * Math.cos(toRad(decl)))

  if (Math.abs(cosHA) > 1) return { sunrise: null, sunset: null }

  const HA = toDeg(Math.acos(cosHA))

  return {
    sunrise: minsToHHMM(solarNoon - HA * 4),
    sunset:  minsToHHMM(solarNoon + HA * 4),
  }
}
