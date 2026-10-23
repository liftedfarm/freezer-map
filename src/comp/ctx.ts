import type { CompApi, DocType, Overview } from './api'
import type { CTab } from './tabs'
import type { Flash } from '../cult/ui'

export interface Ctx {
  api: CompApi; flash: Flash; canEdit: boolean; isAdmin: boolean; types: DocType[]; ov: Overview
  reload: () => Promise<void>; go: (t: CTab, sub?: string) => void; sub: string | null; me: string | null
  typeLabel: (k: string | null | undefined) => string
}
