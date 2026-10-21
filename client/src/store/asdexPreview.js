import { create } from 'zustand'

export const useAsdexPreviewStore = create((set) => ({
  buffer:   '',
  response: '',
  // MF Y / MF H: target picked by click, awaiting typed scratchpad + Enter.
  // { field: 'sp1'|'sp2', unitId } or null.
  pending:  null,
  // The buffer is the DEL key's token (DEL + click removes a note), not typed.
  delKey:   false,

  appendToken:       (token) => set((s) => ({ buffer: s.buffer + token, response: '', delKey: false })),
  appendChar:        (char)  => set((s) => ({ buffer: s.buffer + char, delKey: false })),
  backspace:         ()      => set((s) => ({ buffer: s.buffer.slice(0, -1), delKey: false })),
  armDel:            ()      => set({ buffer: 'DEL', response: '', pending: null, delKey: true }),
  clear:             ()      => set({ buffer: '', response: '', pending: null, delKey: false }),
  setResponse:       (msg)   => set({ response: msg }),
  setPending:        (p)     => set({ pending: p }),
  clearAfterCommand: ()      => set({ buffer: '', response: '', pending: null, delKey: false }),
}))
