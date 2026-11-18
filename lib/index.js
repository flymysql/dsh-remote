import { importWithSelfHeal } from './self-heal.js'

const mainUrl = new URL('./main.js' + new URL(import.meta.url).search, import.meta.url).href
const { module: main, repaired } = await importWithSelfHeal(() => import(mainUrl))

if (repaired) {
  console.warn('[dsh-remote] startup self-repair succeeded — the incomplete update has been fully re-applied and this boot is healthy')
}

export const name = main.name
export const DEFAULT_UPDATE_MODE = main.DEFAULT_UPDATE_MODE
export const decodePickStdout = main.decodePickStdout
export const win32FolderPickScript = main.win32FolderPickScript
export const LOCAL_BOOTSTRAP_TOOLS = main.LOCAL_BOOTSTRAP_TOOLS
export const normalizeLocalTools = main.normalizeLocalTools
export const pickWorkspaceNextStep = main.pickWorkspaceNextStep
export const inject = main.inject
export const Config = main.Config
export const apply = main.apply
