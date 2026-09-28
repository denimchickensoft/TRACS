// BRAA list ordering. Rows without a value for the chosen key (no revealed
// fighter callsign, no range, no intercept solution) always go last, in
// either direction, keeping the order they were added in.

export const BRAA_SORT_KEYS = [
  { value: 'added',    label: 'Added'    },
  { value: 'callsign', label: 'Callsign' },
  { value: 'range',    label: 'Range'    },
  { value: 'tti',      label: 'TTI'      },
]

export const DEFAULT_BRAA_SORT = { key: 'added', dir: 'asc' }

// rows: in the order added; each may carry fighterCallsign (only when
// revealed), braa.range and intercept.ttiSeconds.
function sortValue(row, key, index) {
  switch (key) {
    case 'callsign': return row.fighterCallsign || null
    case 'range':    return Number.isFinite(row.braa?.range) ? row.braa.range : null
    case 'tti':      return Number.isFinite(row.intercept?.ttiSeconds) ? row.intercept.ttiSeconds : null
    default:         return index
  }
}

export function sortBraaRows(rows, { key, dir } = DEFAULT_BRAA_SORT) {
  const sign = dir === 'desc' ? -1 : 1
  return rows
    .map((row, index) => ({ row, index, value: sortValue(row, key, index) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        if (a.value === b.value) return a.index - b.index
        return a.value === null ? 1 : -1
      }
      const cmp = typeof a.value === 'string' ? a.value.localeCompare(b.value) : a.value - b.value
      return cmp !== 0 ? sign * cmp : a.index - b.index
    })
    .map(({ row }) => row)
}
