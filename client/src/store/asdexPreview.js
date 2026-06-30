import { create } from 'zustand'

export const useAsdexPreviewStore = create((set) => ({
  buffer:   '',
  response: '',

  appendToken:       (token) => set((s) => ({ buffer: s.buffer + token, response: '' })),
  appendChar:        (char)  => set((s) => ({ buffer: s.buffer + char })),
  backspace:         ()      => set((s) => ({ buffer: s.buffer.slice(0, -1) })),
  clear:             ()      => set({ buffer: '', response: '' }),
  setResponse:       (msg)   => set({ response: msg }),
  clearAfterCommand: ()      => set({ buffer: '', response: '' }),
}))
