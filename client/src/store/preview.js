import { create } from 'zustand'

export const usePreviewStore = create((set) => ({
  buffer:   '',       // command string accumulating in preview area
  response: '',       // system response / error line
  hasToken: false,    // true once a function-key token has entered the buffer
  leadToken: '',      // the key token the buffer starts with ('HO', 'MF', ...), '' if typed

  // Append a STARS key token (e.g. "IC", "HO", "MF ")
  appendToken: (token) =>
    set((s) => ({ buffer: s.buffer + token, response: '', hasToken: true, leadToken: s.buffer.trim() ? s.leadToken : token.trim() })),

  // Append a single typed character
  appendChar: (char) =>
    set((s) => ({ buffer: s.buffer + char })),

  // Remove last character
  // Backspacing into a leading token drops it.
  backspace: () =>
    set((s) => {
      const buffer = s.buffer.slice(0, -1)
      if (!buffer) return { buffer, hasToken: false, leadToken: '' }
      return s.leadToken && !buffer.startsWith(s.leadToken) ? { buffer, leadToken: '' } : { buffer }
    }),

  // Clear entire buffer (ESC behaviour)
  clear: () => set({ buffer: '', response: '', hasToken: false, leadToken: '' }),

  // Set system response message (error, info, confirmation)
  setResponse: (msg) => set({ response: msg }),
  clearResponse: () => set({ response: '' }),

  // Successful read-only command (e.g. MF F<ENTER>): clear the typed buffer
  // but leave the result showing in the response line, unlike clearAfterCommand.
  showInfo: (msg) => set({ buffer: '', response: msg, hasToken: false, leadToken: '' }),

  // Called after a command executes successfully
  clearAfterCommand: () => set({ buffer: '', response: '', hasToken: false, leadToken: '' }),
}))
