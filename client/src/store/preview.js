import { create } from 'zustand'

export const usePreviewStore = create((set, get) => ({
  buffer:   '',       // command string accumulating in preview area
  response: '',       // system response / error line
  position: null,     // { x, y } screen coords | null = default position

  // Append a STARS key token (e.g. "IC", "HO", "MF ")
  appendToken: (token) =>
    set((s) => ({ buffer: s.buffer + token, response: '' })),

  // Append a single typed character
  appendChar: (char) =>
    set((s) => ({ buffer: s.buffer + char })),

  // Remove last character
  backspace: () =>
    set((s) => ({ buffer: s.buffer.slice(0, -1) })),

  // Clear entire buffer (ESC behaviour)
  clear: () => set({ buffer: '', response: '' }),

  // Set system response message (error, info, confirmation)
  setResponse: (msg) => set({ response: msg }),
  clearResponse: () => set({ response: '' }),

  // Successful read-only command (e.g. MF F<ENTER>): clear the typed buffer
  // but leave the result showing in the response line, unlike clearAfterCommand.
  showInfo: (msg) => set({ buffer: '', response: msg }),

  // Called after a command executes successfully
  clearAfterCommand: () => set({ buffer: '', response: '' }),

  setPosition: (pos) => set({ position: pos }),
}))
