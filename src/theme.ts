// Light / dark / match the device. Saved with the person's settings, and kept in this browser so the page opens in the right theme.
export type Theme = 'light' | 'dark' | 'system'
export function applyTheme(t: Theme | undefined | null) {
  const v = t === 'light' || t === 'dark' ? t : null
  if (v) document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme
  try { if (v) localStorage.setItem('fm.theme', v); else localStorage.removeItem('fm.theme') } catch { /* private mode */ }
}
export function savedTheme(): Theme { try { return (localStorage.getItem('fm.theme') as Theme) || 'system' } catch { return 'system' } }
