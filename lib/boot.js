// Package-root entry: the old lib/index.js entry and this file share the same
// dynamic-import guard, so a half-applied tree can repair itself before the
// static dependency graph of the real plugin body is evaluated.
export * from './index.js'
