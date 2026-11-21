// lib/deck-bridge.js —— 给 dsh-mattpocock-skills-deck 的远端工作区适配层用的公开入口。
//
// 背景：外挂插件 dsh-deck-remote-exec 让 deck 在 dsh-remote 的远端工作区里工作，
//   它需要的只是 dsh-remote 已有的几个纯能力（镜像识别、路径翻译、SSH 连接池）。
//   在此之前它靠「绝对路径动态 import lib/*.js」绕过 package.json 的 exports 限制，
//   因为那些内部模块没有公开导出。这种做法依赖 dsh-remote 的内部文件布局，
//   一旦文件改名或 exports 收紧就会失效，而且无法被 Node 的模块解析静态检查。
//
// 本文件把这些能力里插件实际用到的符号正式导出，插件改成
//   `import { ... } from 'dsh-remote/deck-bridge'` 即可，不再碰内部路径。
// 只导出插件真正需要的 6 个符号，不把整个内部模块摊开——公开面越小，
//   内部实现越能自由演进；要加符号时按插件的实际需要再加。
//
// 这些函数/类本身的实现仍在各自原模块里，这里只做转发，零逻辑。
export { resolveMirror } from './binding.js'
export { SystemOpenSshPool } from './openssh.js'
export { resolveRemoteWorkspacePath, relPathUnder, remoteDirname, shq } from './paths.js'
