'use strict'

// Decoder for the Olympus units binary format.
// Source reference: DCSOlympus backend/core/include/unit.h, datatypes.h, utils/include/utils.h
//                   frontend/react/src/server/dataextractor.ts

// DataIndex enum — mirrors DataIndex::DataIndexes in datatypes.h
const DI = {
  startOfData: 0,
  category: 1,
  alive: 2,
  alarmState: 3,
  radarState: 4,
  human: 5,
  controlled: 6,
  coalition: 7,
  country: 8,
  name: 9,
  unitName: 10,
  callsign: 11,
  unitID: 12,
  groupID: 13,
  groupName: 14,
  state: 15,
  task: 16,
  hasTask: 17,
  position: 18,       // Coords: float64 lat, lng, alt, threshold
  speed: 19,
  horizontalVelocity: 20,
  verticalVelocity: 21,
  heading: 22,
  track: 23,
  isActiveTanker: 24,
  isActiveAWACS: 25,
  onOff: 26,
  followRoads: 27,
  fuel: 28,           // uint16
  desiredSpeed: 29,
  desiredSpeedType: 30,
  desiredAltitude: 31,
  desiredAltitudeType: 32,
  leaderID: 33,       // uint32
  formationOffset: 34, // Offset: float64 x, y, z
  targetID: 35,
  targetPosition: 36, // Coords
  ROE: 37,
  reactionToThreat: 38,
  emissionsCountermeasures: 39,
  TACAN: 40,          // bool + uint8 + char + char[4]
  radio: 41,          // uint32 + uint8 + uint8
  generalSettings: 42, // 5 × bool
  ammo: 43,           // vector<Ammo>
  contacts: 44,       // vector<Contact>
  activePath: 45,     // list<Coords>
  isLeader: 46,
  operateAs: 47,
  shotsScatter: 48,
  shotsIntensity: 49,
  health: 50,
  racetrackLength: 51,
  racetrackAnchor: 52,
  racetrackBearing: 53,
  timeToNextTasking: 54,
  barrelHeight: 55,
  muzzleVelocity: 56,
  aimTime: 57,
  shotsToFire: 58,    // uint32
  shotsBaseInterval: 59,
  shotsBaseScatter: 60,
  engagementRange: 61,
  targetingRange: 62,
  aimMethodRange: 63,
  acquisitionRange: 64,
  airborne: 65,
  cargoWeight: 66,
  drawArguments: 67,  // vector<DrawArgument>
  customString: 68,
  customInteger: 69,  // uint64 (unsigned long)
  posture: 70,
  canTransportUnits: 71,
  onBoardUnitIDs: 72, // vector<uint32>
  maximumTransportableUnits: 73,
  pickupLocation: 74,
  shootingProjectionLocation: 75,
  shootingProjectionWeaponMass: 76,
  suppressionLevel: 77,
  scenicFunctionProbability: 78,
  launcherID: 79,
  endOfData: 255,
}

class Reader {
  constructor(buffer) {
    this.view = new DataView(buffer.buffer ?? buffer)
    this.pos = 0
    this.decoder = new TextDecoder('utf-8')
    this.buffer = buffer.buffer ?? buffer
  }

  bool()    { return this.view.getUint8(this.pos++) > 0 }
  uint8()   { return this.view.getUint8(this.pos++) }
  uint16()  { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v }
  uint32()  { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v }
  uint64()  { const v = this.view.getBigUint64(this.pos, true); this.pos += 8; return Number(v) }
  float64() { const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v }

  string(fixedLen) {
    const len = fixedLen !== undefined ? fixedLen : this.uint16()
    const slice = this.buffer.slice(this.pos, this.pos + len)
    this.pos += len
    // Trim at first null byte, then trim whitespace
    const arr = new Uint8Array(slice)
    let end = arr.indexOf(0)
    if (end === -1) end = len
    return this.decoder.decode(slice.slice(0, end)).trim()
  }

  coords() {
    const lat = this.float64()
    const lng = this.float64()
    const alt = this.float64()
    this.float64() // threshold — internal only
    return { lat, lng, alt }
  }

  offset() {
    return { x: this.float64(), y: this.float64(), z: this.float64() }
  }

  tacan() {
    return {
      isOn:       this.bool(),
      channel:    this.uint8(),
      XY:         this.string(1),
      callsign:   this.string(4),
    }
  }

  radio() {
    return {
      frequency:       this.uint32(),
      callsign:        this.uint8(),
      callsignNumber:  this.uint8(),
    }
  }

  generalSettings() {
    return {
      prohibitJettison:    this.bool(),
      prohibitAA:          this.bool(),
      prohibitAG:          this.bool(),
      prohibitAfterburner: this.bool(),
      prohibitAirWpn:      this.bool(),
    }
  }

  ammoVector() {
    const count = this.uint16()
    const result = []
    for (let i = 0; i < count; i++) {
      result.push({
        quantity:        this.uint16(),
        name:            this.string(33),
        guidance:        this.uint8(),
        category:        this.uint8(),
        missileCategory: this.uint8(),
      })
    }
    return result
  }

  contactVector() {
    const count = this.uint16()
    const result = []
    for (let i = 0; i < count; i++) {
      result.push({ ID: this.uint32(), detectionMethod: this.uint8() })
    }
    return result
  }

  coordsList() {
    const count = this.uint16()
    const result = []
    for (let i = 0; i < count; i++) result.push(this.coords())
    return result
  }

  drawArgumentsVector() {
    const count = this.uint16()
    const result = []
    for (let i = 0; i < count; i++) {
      result.push({ argument: this.uint32(), value: this.float64() })
    }
    return result
  }

  onBoardUnitsVector() {
    const count = this.uint16()
    const result = []
    for (let i = 0; i < count; i++) result.push(this.uint32())
    return result
  }
}

/**
 * Decode an Olympus units binary response buffer.
 *
 * @param {Buffer} buffer — raw response body from GET /olympus/units
 * @returns {{ updateTime: number, units: Object[] }}
 *   updateTime — server timestamp to pass as ?time= on the next poll
 *   units      — array of decoded unit objects (only fields present in this delta)
 */
function decodeUnits(buffer) {
  const r = new Reader(buffer)
  const updateTime = r.uint64()
  const units = []

  while (r.pos < buffer.length) {
    const id = r.uint32()
    const unit = { id }

    let fieldIndex
    while ((fieldIndex = r.uint8()) !== DI.endOfData) {
      switch (fieldIndex) {
        case DI.category:              unit.category = r.string(); break
        case DI.alive:                 unit.alive = r.bool(); break
        case DI.alarmState:            unit.alarmState = r.uint8(); break
        case DI.radarState:            unit.radarState = r.bool(); break
        case DI.human:                 unit.human = r.bool(); break
        case DI.controlled:            unit.controlled = r.bool(); break
        case DI.coalition:             unit.coalition = r.uint8(); break
        case DI.country:               unit.country = r.uint8(); break
        case DI.name:                  unit.name = r.string(); break
        case DI.unitName:              unit.unitName = r.string(); break
        case DI.callsign:              unit.callsign = r.string(); break
        case DI.unitID:                unit.unitID = r.uint32(); break
        case DI.groupID:               unit.groupID = r.uint32(); break
        case DI.groupName:             unit.groupName = r.string(); break
        case DI.state:                 unit.state = r.uint8(); break
        case DI.task:                  unit.task = r.string(); break
        case DI.hasTask:               unit.hasTask = r.bool(); break
        case DI.position:              unit.position = r.coords(); break
        case DI.speed:                 unit.speed = r.float64(); break
        case DI.horizontalVelocity:    unit.horizontalVelocity = r.float64(); break
        case DI.verticalVelocity:      unit.verticalVelocity = r.float64(); break
        case DI.heading:               unit.heading = r.float64(); break
        case DI.track:                 unit.track = r.float64(); break
        case DI.isActiveTanker:        unit.isActiveTanker = r.bool(); break
        case DI.isActiveAWACS:         unit.isActiveAWACS = r.bool(); break
        case DI.onOff:                 unit.onOff = r.bool(); break
        case DI.followRoads:           unit.followRoads = r.bool(); break
        case DI.fuel:                  unit.fuel = r.uint16(); break
        case DI.desiredSpeed:          unit.desiredSpeed = r.float64(); break
        case DI.desiredSpeedType:      unit.desiredSpeedType = r.bool(); break
        case DI.desiredAltitude:       unit.desiredAltitude = r.float64(); break
        case DI.desiredAltitudeType:   unit.desiredAltitudeType = r.bool(); break
        case DI.leaderID:              unit.leaderID = r.uint32(); break
        case DI.formationOffset:       unit.formationOffset = r.offset(); break
        case DI.targetID:              unit.targetID = r.uint32(); break
        case DI.targetPosition:        unit.targetPosition = r.coords(); break
        case DI.ROE:                   unit.ROE = r.uint8(); break
        case DI.reactionToThreat:      unit.reactionToThreat = r.uint8(); break
        case DI.emissionsCountermeasures: unit.emissionsCountermeasures = r.uint8(); break
        case DI.TACAN:                 unit.TACAN = r.tacan(); break
        case DI.radio:                 unit.radio = r.radio(); break
        case DI.generalSettings:       unit.generalSettings = r.generalSettings(); break
        case DI.ammo:                  unit.ammo = r.ammoVector(); break
        case DI.contacts:              unit.contacts = r.contactVector(); break
        case DI.activePath:            unit.activePath = r.coordsList(); break
        case DI.isLeader:              unit.isLeader = r.bool(); break
        case DI.operateAs:             unit.operateAs = r.uint8(); break
        case DI.shotsScatter:          unit.shotsScatter = r.uint8(); break
        case DI.shotsIntensity:        unit.shotsIntensity = r.uint8(); break
        case DI.health:                unit.health = r.uint8(); break
        case DI.racetrackLength:       unit.racetrackLength = r.float64(); break
        case DI.racetrackAnchor:       unit.racetrackAnchor = r.coords(); break
        case DI.racetrackBearing:      unit.racetrackBearing = r.float64(); break
        case DI.timeToNextTasking:     unit.timeToNextTasking = r.float64(); break
        case DI.barrelHeight:          unit.barrelHeight = r.float64(); break
        case DI.muzzleVelocity:        unit.muzzleVelocity = r.float64(); break
        case DI.aimTime:               unit.aimTime = r.float64(); break
        case DI.shotsToFire:           unit.shotsToFire = r.uint32(); break
        case DI.shotsBaseInterval:     unit.shotsBaseInterval = r.float64(); break
        case DI.shotsBaseScatter:      unit.shotsBaseScatter = r.float64(); break
        case DI.engagementRange:       unit.engagementRange = r.float64(); break
        case DI.targetingRange:        unit.targetingRange = r.float64(); break
        case DI.aimMethodRange:        unit.aimMethodRange = r.float64(); break
        case DI.acquisitionRange:      unit.acquisitionRange = r.float64(); break
        case DI.airborne:              unit.airborne = r.bool(); break
        case DI.cargoWeight:           unit.cargoWeight = r.float64(); break
        case DI.drawArguments:         unit.drawArguments = r.drawArgumentsVector(); break
        case DI.customString:          unit.customString = r.string(); break
        case DI.customInteger:         unit.customInteger = r.uint64(); break
        case DI.posture:               unit.posture = r.uint8(); break
        case DI.canTransportUnits:     unit.canTransportUnits = r.bool(); break
        case DI.onBoardUnitIDs:        unit.onBoardUnitIDs = r.onBoardUnitsVector(); break
        case DI.maximumTransportableUnits: unit.maximumTransportableUnits = r.uint32(); break
        case DI.pickupLocation:        unit.pickupLocation = r.coords(); break
        case DI.shootingProjectionLocation: unit.shootingProjectionLocation = r.coords(); break
        case DI.shootingProjectionWeaponMass: unit.shootingProjectionWeaponMass = r.float64(); break
        case DI.suppressionLevel:      unit.suppressionLevel = r.float64(); break
        case DI.scenicFunctionProbability: unit.scenicFunctionProbability = r.float64(); break
        case DI.launcherID:            unit.launcherID = r.uint32(); break
        default:
          // Unknown field index — we can't safely skip without knowing the size.
          // Log and abort decoding this buffer to avoid reading garbage.
          console.warn(`[decoder] unknown field index ${fieldIndex} at byte ${r.pos - 1}, aborting unit decode`)
          return { updateTime, units }
      }
    }

    units.push(unit)
  }

  return { updateTime, units }
}

module.exports = { decodeUnits }
