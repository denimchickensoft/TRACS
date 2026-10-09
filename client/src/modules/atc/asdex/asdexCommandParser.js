const ASDEX_COMMANDS = [
  { id: 'OPEN_FPE',           pattern: /^\.FP (.+)$/,       trigger: 'ENTER', captures: ['aid'] },
  { id: 'OPEN_FPE',           pattern: /^\.FP$/,             trigger: 'ENTER' },
  { id: 'TOGGLE_CENTERLINE',  pattern: /^\.CENTERLINE$/,     trigger: 'ENTER' },
  { id: 'TOGGLE_COORDS',      pattern: /^\.COORDS$/,         trigger: 'ENTER' },
  { id: 'METRIC_UNITS',       pattern: /^\.METRIC$/,         trigger: 'ENTER' },
  { id: 'IMPERIAL_UNITS',     pattern: /^\.IMPERIAL$/,       trigger: 'ENTER' },
  { id: 'SET_COLORS',         pattern: /^\.COLORS (.+)$/,    trigger: 'ENTER', captures: ['name'] },
  { id: 'SET_LEADER_SHORT',   pattern: /^([1-9])$/,          trigger: 'SLEW',  captures: ['dir'] },
  // Manual tag: type the aircraft ID, then click the unknown target.
  { id: 'TAG_TARGET',         pattern: /^\.TAG (.+)$/,       trigger: 'SLEW',  captures: ['aid'] },
  { id: 'RENAME_CALLSIGN',    pattern: /^\.RENAME (.+)$/,    trigger: 'SLEW',  captures: ['newCallsign'] },
  { id: 'RESET_CALLSIGN',     pattern: /^\.RENAME$/,         trigger: 'SLEW' },
]

export function parseAsdexCommand(buffer, trigger) {
  const trimmed = buffer.trim().toUpperCase()
  for (const cmd of ASDEX_COMMANDS) {
    if (cmd.trigger !== trigger && cmd.trigger !== 'EITHER') continue
    const match = trimmed.match(cmd.pattern)
    if (!match) continue
    const captures = {}
    if (cmd.captures) cmd.captures.forEach((name, i) => { captures[name] = match[i + 1] })
    return { command: cmd, captures }
  }
  return null
}
