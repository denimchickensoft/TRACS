// DCS mission dateAndTime payloads are theatre-local, not UTC/Zulu. Each DCS
// terrain uses a fixed UTC offset (not derived from the map's real-world
// longitude) — see https://github.com/pydcs/dcs terrain definitions.
// Keys match the theatre names used in client/public/projection_params.json.
export const THEATRE_UTC_OFFSETS = {
  Caucasus:        4,
  SouthAtlantic:  -3, // Falklands map
  Germany:         2,
  Kola:            3,
  MarianaIslands:  10,
  Nevada:         -8,
  Normandy:        0,
  PersianGulf:     4,
  Sinai:           2,
  Syria:           3,
  TheChannel:      2,
}

export function getTheatreUtcOffset(theatre) {
  return THEATRE_UTC_OFFSETS[theatre] ?? 0
}

// Converts a theatre-local { Day, Month, Year } + { h, m, s } pair to true UTC.
export function toUtcDateTime(date, time, theatre) {
  const offsetHours = getTheatreUtcOffset(theatre)
  const localMs = Date.UTC(date.Year, date.Month - 1, date.Day, time.h ?? 0, time.m ?? 0, time.s ?? 0)
  const utc = new Date(localMs - offsetHours * 3600000)
  return {
    date: { Day: utc.getUTCDate(), Month: utc.getUTCMonth() + 1, Year: utc.getUTCFullYear() },
    time: { h: utc.getUTCHours(), m: utc.getUTCMinutes(), s: utc.getUTCSeconds() },
  }
}
