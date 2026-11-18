// Package-root entry. Forward the caller's URL query through the shared
// self-heal guard so cache-busted consumers keep isolated module state.
const indexUrl = new URL('./index.js' + new URL(import.meta.url).search, import.meta.url).href
const main = await import(indexUrl)

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
