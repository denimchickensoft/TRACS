// Re-exported from the shared tracs-geo-math workspace package — server
// build scripts previously reached into this file
// across the workspace boundary via relative `../../client/src/utils/...`
// imports; this file now just re-exports so existing client call sites
// don't need to change. See packages/geo-math/transverseMercator.js for the
// actual implementation and its Karney-series accuracy notes.
export { tmForward, tmInverse } from 'tracs-geo-math'
