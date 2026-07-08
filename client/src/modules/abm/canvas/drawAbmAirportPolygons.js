/**
 * Renders airport surface polygons (taxiway/runway pavement) theatre-wide,
 * unfiltered — unlike ASDE-X's drawAsdexSurface, which is scoped to one
 * facility and also clears the canvas + paints an opaque background (it owns
 * a dedicated canvas). ABM composites this into a shared multi-layer canvas
 * alongside geo/relief/airways/etc, so it only fills the polygons themselves.
 */

import { latLngToCanvas } from '../../atc/stars/canvas/projection.js'

export function drawAbmAirportPolygons(ctx, view, features, visible, taxiwayColor = '#3a3a3a', runwayColor = '#5a5a5a') {
  if (!visible || !features?.length) return

  for (const feature of features) {
    ctx.fillStyle = feature.properties.type === 'runway' ? runwayColor : taxiwayColor
    ctx.beginPath()
    for (const ring of feature.geometry.coordinates) {
      for (let i = 0; i < ring.length; i++) {
        const [lng, lat] = ring[i]
        const { x, y } = latLngToCanvas(lat, lng, view)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
    }
    ctx.fill()
  }
}
