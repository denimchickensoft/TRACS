// Debug/info console output, silent in production builds unless the
// `tracs.debug` localStorage flag is set. To turn it on in a packaged build,
// run `localStorage.setItem('tracs.debug', '1')` in DevTools and reload.
// console.warn/console.error are for real problems and stay ungated.

function readDebugFlag() {
  try { return localStorage.getItem('tracs.debug') === '1' } catch { return false }
}

const enabled = import.meta.env.DEV || readDebugFlag()
const noop = () => {}

export const log = {
  debug: enabled ? console.debug.bind(console) : noop,
  info:  enabled ? console.info.bind(console)  : noop,
}
