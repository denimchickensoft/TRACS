import { create } from 'zustand'

export const usePreviewStore = create((set) => ({
  buffer:   '',       // command string accumulating in preview area
  response: '',       // system response / error line
  hasToken: false,    // true once a function-key token has entered the buffer

  // Append a STARS key token (e.g. "IC", "HO", "MF ")
  appendToken: (token) =>
    set((s) => ({ buffer: s.buffer + token, response: '', hasToken: true })),

  // Append a single typed character
  appendChar: (char) =>
    set((s) => ({ buffer: s.buffer + char })),

  // Remove last character
  backspace: () =>
    set((s) => {
      const buffer = s.buffer.slice(0, -1)
      return buffer ? { buffer } : { buffer, hasToken: false }
    }),

  // Clear entire buffer (ESC behaviour)
  clear: () => set({ buffer: '', response: '', hasToken: false }),

  // Set system response message (error, info, confirmation)
  setResponse: (msg) => set({ response: msg }),
  clearResponse: () => set({ response: '' }),

  // Successful read-only command (e.g. MF F<ENTER>): clear the typed buffer
  // but leave the result showing in the response line, unlike clearAfterCommand.
  showInfo: (msg) => set({ buffer: '', response: msg, hasToken: false }),

  // Called after a command executes successfully
  clearAfterCommand: () => set({ buffer: '', response: '', hasToken: false }),
}))
