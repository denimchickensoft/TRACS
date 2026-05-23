import { useCabPreviewStore } from '../../../store/cabPreview.js'

export function CabPreviewArea() {
  const { buffer, response } = useCabPreviewStore()

  return (
    <div style={{
      position:      'absolute',
      left:          12,
      top:           12,
      fontFamily:    '"Roboto Mono", monospace',
      fontSize:      '12px',
      lineHeight:    '17px',
      color:         '#00cc00',
      background:    'rgba(0,0,0,0.6)',
      padding:       '3px 6px',
      pointerEvents: 'none',
      userSelect:    'none',
      whiteSpace:    'pre',
      zIndex:        500,
    }}>
      {response && <div style={{ color: '#FF4444' }}>{response}</div>}
      <div>{buffer || ' '}</div>
    </div>
  )
}
