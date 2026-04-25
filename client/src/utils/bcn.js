const RESERVED = new Set(['0000', '1200', '2000', '7400', '7500', '7600', '7700', '7777'])

/**
 * Generate a random compliant beacon code.
 * 4 digits, each 0-7 (octal). Excludes reserved codes and any already in use.
 *
 * @param {Object} existingPlans  flightPlans store plans object
 * @returns {string}  4-character string, e.g. "4521"
 */
export function generateBcn(existingPlans = {}) {
  const used = new Set(
    Object.values(existingPlans).map((p) => p.bcn).filter(Boolean)
  )

  for (let i = 0; i < 2000; i++) {
    const code = Array.from({ length: 4 }, () => Math.floor(Math.random() * 8)).join('')
    if (!RESERVED.has(code) && !used.has(code)) return code
  }

  // Exhaustive fallback — find first available sequentially
  for (let n = 0; n <= 7777; n++) {
    const digits = n.toString(8).padStart(4, '0')
    if (!RESERVED.has(digits) && !used.has(digits)) return digits
  }
  return '0001'
}
