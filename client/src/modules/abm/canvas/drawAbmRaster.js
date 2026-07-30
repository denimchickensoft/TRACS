/**
 * Renders one of ABM's baked rasters — basemap (terrain/coastline/
 * boundaries), water (rivers/lakes), or roads (roads/rail); see server's
 * buildAbmBasemap.js. Each image is baked north-up in the theatre's own
 * unrotated TM nm-plane, so placing it is a single affine transform anchored
 * on its origin point — latLngToCanvas already folds in the TM forward
 * projection, the pan offset, the declination rotation, and the pixelsPerNm
 * scale for that one point, and because latLngToCanvas's own composition
 * (rotate → scale → translate) is itself affine, the same rotate+scale
 * carries every other pixel of the pre-projected image correctly too — no
 * per-pixel reprojection needed at render time, unlike the vector layers
 * (drawRelief/drawGeo/etc), which reproject every point every frame.
 */

import { latLngToCanvas } from '../../atc/stars/canvas/projection.js'

export function drawAbmRaster(ctx, view, raster, visible, brite = 100) {
  if (!visible || !raster?.img || brite <= 0) return
  const { img, originLat, originLng, originPx, originPy, nmPerPixel } = raster
  const { x: cx, y: cy } = latLngToCanvas(originLat, originLng, view)
  const scale = nmPerPixel * view.pixelsPerNm
  const theta = -(view.declinationDeg ?? 0) * Math.PI / 180

  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, brite / 100))
  ctx.translate(cx, cy)
  ctx.rotate(theta)
  ctx.scale(scale, scale)
  // Anchor on the origin point's own pixel, not the image's geometric
  // center — the two aren't the same (see buildAbmBasemap.js's originPx/Py
  // comment): a theatre's bbox is rarely symmetric around its own TM central
  // meridian, so the baked image's bounding box is generally off-center
  // relative to the origin lat/lng this whole transform is anchored on.
  ctx.drawImage(img, -originPx, -originPy)
  ctx.restore()
}
