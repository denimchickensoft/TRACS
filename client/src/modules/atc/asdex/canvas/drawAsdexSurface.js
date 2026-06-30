import { latLngToCanvas } from '../../stars/canvas/projection.js'

export function drawAsdexSurface(ctx, view, features, colors) {
  ctx.clearRect(0, 0, view.width, view.height)

  ctx.fillStyle = colors.background
  ctx.fillRect(0, 0, view.width, view.height)

  if (!features || !features.length) return

  // Features are ordered: taxiways first, then runways (guaranteed by build script).
  // Sequential draw produces correct layering without sorting.
  for (const feature of features) {
    ctx.fillStyle = feature.properties.type === 'runway' ? colors.runway : colors.taxiway
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
