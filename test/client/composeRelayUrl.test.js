import { describe, it, expect } from 'vitest'
import { composeRelayUrl, parseHostPort } from '../../client/src/utils/serverProfiles.js'

describe('composeRelayUrl', () => {
  it('Relay mode, blank port: the scheme standard port (reverse proxy / tunnel at a domain name)', () => {
    expect(composeRelayUrl('https://relay.example.com', '', 'relay')).toBe('wss://relay.example.com')
    expect(composeRelayUrl('relay.example.com', '', 'relay')).toBe('ws://relay.example.com')
    expect(composeRelayUrl('https://relay.example.com/', '', 'relay')).toBe('wss://relay.example.com')
  })

  it('Relay mode with a port keeps it', () => {
    expect(composeRelayUrl('https://relay.example.com', '8766', 'relay')).toBe('wss://relay.example.com:8766')
    expect(composeRelayUrl('1.2.3.4', '8765', 'relay')).toBe('ws://1.2.3.4:8765')
  })

  it('Olympus/Tacview modes: a blank port still means no relay', () => {
    expect(composeRelayUrl('https://relay.example.com', '', 'olympus')).toBe('')
    expect(composeRelayUrl('1.2.3.4', '', 'tacview-direct')).toBe('')
    expect(composeRelayUrl('1.2.3.4', '8765', 'olympus')).toBe('ws://1.2.3.4:8765')
  })

  it('no host, no relay', () => {
    expect(composeRelayUrl('', '', 'relay')).toBe('')
    expect(composeRelayUrl('   ', '8765', 'relay')).toBe('')
  })

  it('drops the Server URL path', () => {
    expect(composeRelayUrl('https://host.example.com/olympus', '', 'relay')).toBe('wss://host.example.com')
  })

  it('a saved portless relay URL reloads as a blank Relay Port and recomposes the same', () => {
    const saved = composeRelayUrl('https://relay.example.com', '', 'relay')
    const { port } = parseHostPort(saved)
    expect(port).toBe('')
    expect(composeRelayUrl('https://relay.example.com', port, 'relay')).toBe(saved)
  })

  it('the relay endpoints built from it default to port 443 over wss', () => {
    const u = new URL(`${composeRelayUrl('https://relay.example.com', '', 'relay')}/sync`)
    expect(u.protocol).toBe('wss:')
    expect(u.port).toBe('')            // default port for wss
    expect(u.host).toBe('relay.example.com')
  })
})
