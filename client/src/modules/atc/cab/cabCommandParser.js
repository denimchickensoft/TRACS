const CAB_COMMANDS = [
  { id: 'OPEN_FPE',           pattern: /^\.FP (.+)$/,      trigger: 'ENTER', captures: ['aid'] },
  { id: 'OPEN_FPE',           pattern: /^\.FP$/,            trigger: 'ENTER' },
  { id: 'TOGGLE_CENTERLINE',  pattern: /^\.CENTERLINE$/,    trigger: 'ENTER' },
  { id: 'TOGGLE_COORDS',      pattern: /^\.COORDS$/,        trigger: 'ENTER' },
]

export function parseCabCommand(buffer, trigger) {
  const trimmed = buffer.trim().toUpperCase()
  for (const cmd of CAB_COMMANDS) {
    if (cmd.trigger !== trigger && cmd.trigger !== 'EITHER') continue
    const match = trimmed.match(cmd.pattern)
    if (!match) continue
    const captures = {}
    if (cmd.captures) cmd.captures.forEach((name, i) => { captures[name] = match[i + 1] })
    return { command: cmd, captures }
  }
  return null
}
