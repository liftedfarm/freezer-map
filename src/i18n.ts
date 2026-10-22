// Language: English (the source text) or Spanish. Screens wrap their words in t('English text');
// anything without a Spanish entry yet just shows in English.
import { EN, ES } from './i18n.es'

export type Lang = 'en' | 'es'
export const LANGS: [Lang, string][] = [['en', 'English'], ['es', 'Español']]

const KEY = 'fm.lang'
let cur: Lang = (() => { try { return localStorage.getItem(KEY) === 'es' ? 'es' : 'en' } catch { return 'en' } })()

export const lang = () => cur
export function setLang(l: Lang | null | undefined) {
  cur = l === 'es' ? 'es' : 'en'
  try { localStorage.setItem(KEY, cur) } catch { /* private window */ }
  try { document.documentElement.lang = cur } catch { /* no document */ }
}

/** t('Cut on'), t('{n} trays', { n: 4 }) */
export function t(s: string, v?: Record<string, string | number | null | undefined>): string {
  let out = (cur === 'es' ? ES[s] : undefined) ?? EN[s] ?? s
  if (v) out = out.replace(/\{(\w+)\}/g, (_, k: string) => (v[k] == null ? '' : String(v[k])))
  return out
}
/** pick the plural: tn(n, '{n} batch', '{n} batches') */
export const tn = (n: number, one: string, many: string) => t(n === 1 ? one : many, { n: n.toLocaleString() })

export const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
export const MONTHS_LONG_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
