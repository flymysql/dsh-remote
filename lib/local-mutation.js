// Native filesystem tools operate on the host mirror, not its SSH origin.
// Use the same gate for root native calls and nested PTC dispatches.
export const LOCAL_MUTATION_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
export function remoteLocalMutationDecision(exec, binding) {
  if (!binding?.bound || !LOCAL_MUTATION_TOOLS.has(exec?.name)) return null
  if (exec.name === 'str_replace_editor' && exec.arguments?.command === 'view') return null
  return { kind: 'deny', reason: `${exec.name} was not executed: this session is a REMOTE workspace, but this tool writes only the LOCAL mirror. Use rw_write_file to create remote files or rw_edit to modify them; workspace-relative paths and local-mirror paths are accepted. A local write does not publish a remote file or make a remote file link valid. If a local artifact already exists, explicitly upload it with rw_push/rw_upload and verify it remotely before reporting a remote link.` }
}
