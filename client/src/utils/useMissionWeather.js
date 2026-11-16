import { useMissionDataStore } from '../store/missionData.js'
import { parseMissionText } from './missionFile.js'
import { missionWeather } from './liveWeather.js'

// The running mission file's weather ({ qnhHpa, wind }, see missionWeather),
// from the mission the DCS exporter's relay serves, or null. Parsed once per
// mission: the text can be large, and every window that shows weather asks.
let cached = { id: null, weather: null }

function weatherFor(data) {
  if (!data) return null
  if (cached.id !== data.id) {
    let weather = null
    try { weather = missionWeather(parseMissionText(data.text)) } catch { /* unreadable mission: no weather */ }
    cached = { id: data.id, weather }
  }
  return cached.weather
}

export function useMissionWeather() {
  return useMissionDataStore((s) => weatherFor(s.data))
}
