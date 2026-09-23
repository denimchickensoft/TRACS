import { create } from 'zustand'

export const useAsdexPreviewStore = create((set) => ({
  buffer:   '',
  response: '',
  // MF Y / MF H: target picked by click, awaiting typed scratchpad + Enter.
  // { field: 'sp1'|'sp2', unitId } or null.
  pending:  null,

  appendToken:       (token) => set((s) => ({ buffer: s.buffer + token, response: '' })),
  appendChar:        (char)  => set((s) => ({ buffer: s.buffer + char })),
  backspace:         ()      => set((s) => ({ buffer: s.buffer.slice(0, -1) })),
  clear:             ()      => set({ buffer: '', response: '', pending: null }),
  setResponse:       (msg)   => set({ response: msg }),
  setPending:        (p)     => set({ pending: p }),
  clearAfterCommand: ()      => set({ buffer: '', response: '', pending: null }),
}))
