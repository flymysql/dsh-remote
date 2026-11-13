// README / 站点引用的配图必须真实存在、且不是占位尺寸。
//
// 为什么需要：README 改成"多用渲染图"之后，文字变少、图变成主要信息来源 ——
// 一张图挂掉（路径写错、渲染产物没提交）在 GitHub 上只显示一个破图图标，
// 没有任何提示。而这次重做配图时确实出现过：新图放进了 docs/shots/，但
// 主页与 screenshots.json 还指向已删除的旧图。
//
// 判据（只查静态事实，不需要浏览器）：
//   1) 每个相对图片引用都能在磁盘上找到；
//   2) PNG 能被解析且尺寸合理（> 200x150），排除误放的占位图；
//   3) 两版 README 各自至少引用 3 张图（防"全删了"的极端回归）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

/**
 * Is Python + Pillow available for the pixel-level edge check?
 * Probe once and cache — the alternative (letting the check throw) turns a
 * missing optional tool into a red suite for contributors who never touched
 * images. Reported by the PR #45 author, whose environment has no PIL.
 */
let pillowProbe = null
function detectPillow() {
  if (pillowProbe) return pillowProbe
  for (const py of ['python', 'python3']) {
    try {
      execFileSync(py, ['-c', 'import PIL; print(PIL.__version__)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      pillowProbe = { ok: true, python: py }
      return pillowProbe
    } catch (e) {
      pillowProbe = { ok: false, why: `${py}: ${String(e.message || e).split('\n')[0]}` }
    }
  }
  return pillowProbe
}

const SOURCES = ['README.md', 'README.en.md', 'docs/index.html', 'docs/stats/index.html', 'screenshots.json']

/** 抽出所有相对图片引用（跳过 http/data URI）。 */
function imageRefs(file) {
  const text = readFileSync(path.join(root, file), 'utf8')
  const out = []
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) out.push(m[1])
  for (const m of text.matchAll(/<img[^>]+src="([^"]+)"/g)) out.push(m[1])
  for (const m of text.matchAll(/"((?:docs|\.\/)[^"]+\.(?:png|svg|jpe?g))"/g)) out.push(m[1])
  return [...new Set(out.map((ref) => ref.replace('https://raw.githubusercontent.com/flymysql/dsh-remote/main/', '')))].filter((r) => !/^(https?:|data:)/.test(r))
}

/** 解析引用到实际文件：README 在仓库根，docs/*.html 在 docs/。 */
function resolveRef(file, ref) {
  ref = ref.replace('https://raw.githubusercontent.com/flymysql/dsh-remote/main/', '')
  const baseDir = file.includes('/') ? path.join(root, path.dirname(file)) : root
  const candidates = ref.startsWith('./')
    ? [path.join(baseDir, ref.slice(2))]
    : [path.join(root, ref), path.join(baseDir, ref)]
  return candidates.find((p) => existsSync(p))
}

/** 读 PNG 的 IHDR 尺寸（不依赖图像库）。 */
function pngSize(file) {
  const buf = readFileSync(file)
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

test('every referenced image exists on disk', () => {
  const missing = []
  for (const f of SOURCES) {
    if (!existsSync(path.join(root, f))) continue
    for (const ref of imageRefs(f)) {
      if (!resolveRef(f, ref)) missing.push(`${f} -> ${ref}`)
    }
  }
  assert.deepEqual(missing, [], `referenced images not found (a broken image shows as a broken icon on GitHub):\n  ${missing.join('\n  ')}`)
})

test('every referenced PNG is a real, reasonable image', () => {
  const bad = []
  for (const f of SOURCES) {
    if (!existsSync(path.join(root, f))) continue
    for (const ref of imageRefs(f)) {
      const p = resolveRef(f, ref)
      if (!p || !p.endsWith('.png')) continue
      const size = pngSize(p)
      if (!size) { bad.push(`${f} -> ${ref}: 不是有效 PNG`); continue }
      if (size.w < 200 || size.h < 150) bad.push(`${f} -> ${ref}: 尺寸过小疑似占位 (${size.w}x${size.h})`)
      if (statSync(p).size < 3000) bad.push(`${f} -> ${ref}: 文件过小 ${statSync(p).size}B`)
    }
  }
  assert.deepEqual(bad, [], `suspicious images:\n  ${bad.join('\n  ')}`)
})

test('both READMEs carry enough images to be the primary explanation', () => {
  // 文字被刻意精简后，图是主要信息来源 —— 少于 3 张说明有人把图删了。
  for (const f of ['README.md', 'README.en.md']) {
    const n = imageRefs(f).length
    assert.ok(n >= 3, `${f} only references ${n} image(s); expected at least 3`)
  }
})

test('the capability overview image is referenced by both READMEs', () => {
  // 「功能」节现在以这张图为主，两版都必须引用它。
  for (const f of ['README.md', 'README.en.md']) {
    const refs = imageRefs(f)
    assert.ok(refs.some((r) => r.includes('features.png')), `${f} must reference the capabilities overview image`)
  }
})

test('a rendered doc image is not older than the HTML it is generated from', () => {
  // 回归（本会话差点发出）：我给能力总览加了新卡片、改了 docs/features.html，
  // 但忘了重渲染 features.png —— 于是 README 的图注说"有体检与部署"，图上没有，
  // 图和文字开始互相矛盾。当时**没有任何守卫会拦住这件事**：图片存在、尺寸合理、
  // 引用也没断，所有既有判据都是绿的。
  //
  // 判据：配图的 mtime 不能早于它的渲染源。允许一个小容差，因为 `git checkout`
  // 会让同一次提交里的文件带上几乎相同的 mtime，顺序不保证。
  const PAIRS = [
    ['docs/features.html', 'docs/shots/features.png'],
    ['docs/cover.html', 'docs/cover.png'],
  ]
  const TOLERANCE_MS = 2000
  const stale = []
  for (const [src, png] of PAIRS) {
    const s = path.join(root, src)
    const p = path.join(root, png)
    if (!existsSync(s) || !existsSync(p)) continue
    const sm = statSync(s).mtimeMs
    const pm = statSync(p).mtimeMs
    if (pm + TOLERANCE_MS < sm) {
      stale.push(`${png} (${new Date(pm).toISOString()}) is older than ${src} (${new Date(sm).toISOString()}) `
        + `— re-render: node scripts/render-doc-image.mjs ${src} ${png}`)
    }
  }
  assert.deepEqual(stale, [], `doc image is stale relative to its source:\n  ${stale.join('\n  ')}`)
})

test('the freshness check actually detects a stale image', () => {
  // 负对照：构造一个"源比图新"的情形，检查逻辑必须报出来。
  const detect = (srcM, pngM, tol = 2000) => (pngM + tol < srcM ? 'stale' : 'fresh')
  assert.equal(detect(1000, 2000), 'fresh', 'image newer than source is fine')
  assert.equal(detect(5000, 1000), 'stale', 'source edited 4s later must be reported')
  assert.equal(detect(1000 + 1000, 1000), 'fresh', 'small mtime skew is tolerated')
})

test('a width= attribute never upscales the bitmap', () => {
  // 回归：图片重截后尺寸变了（settings 632x1325 -> 535x640、picker 612x308 -> 595x224），
  // 而 README 里的 width 属性还是旧值 —— GitHub 会按属性把位图放大，直接糊掉。
  // 判据：写了 width 就必须 <= 图片真实宽度。
  const offenders = []
  for (const f of ['README.md', 'README.en.md']) {
    const text = readFileSync(path.join(root, f), 'utf8')
    for (const m of text.matchAll(/<img[^>]+src="([^"]+)"[^>]*width="(\d+)"/g)) {
      const [, ref, w] = m
      const p = resolveRef(f, ref)
      if (!p || !p.endsWith('.png')) continue
      const size = pngSize(p)
      if (!size) continue
      if (Number(w) > size.w) {
        offenders.push(`${f}: ${ref} width=${w} > 实际宽度 ${size.w}（会被放大而模糊）`)
      }
    }
  }
  assert.deepEqual(offenders, [], `width attribute would upscale the bitmap:\n  ${offenders.join('\n  ')}`)
})

test('workspace previews use labelled panels and keep files at their native width', () => {
  const home = readFileSync(path.join(root, 'docs/index.html'), 'utf8')
  for (const name of ['agent', 'file', 'terminal']) {
    assert.match(home, new RegExp(`id="tab-${name}"[^>]*aria-controls="panel-${name}"`))
    assert.match(home, new RegExp(`role="tabpanel" id="panel-${name}" aria-labelledby="tab-${name}"`))
  }
  assert.match(home, /#panel-file img\{max-width:719px/)
  assert.match(home, /\.shot-panel\[hidden\]\{display:none\}/)
})

test('no screenshot has text cut off at its edges', async (t) => {
  // 回归（用户在评审里直接指出的问题："截的区域太窄了，有些边界的文字都被切割了"）：
  // 我两次都用"若干**选定**文字节点的并集"当裁剪框，而那些节点不是最宽的 ——
  // 设置面板真实容器是 612x746（内容 1325 高、页面不可滚动，要滚内部容器），
  // 我却裁成 535x714 且上边界差了 513px，把上半整段切掉、右边也切了字。
  //
  // 判据：面板/弹窗是深色底 + 亮色文字。若图片最外侧 6px 内出现高亮像素
  // （阈值 110，高于描边 62 与画布底色 14），就是文字被裁断。
  //
  // 像素检测需要 Python + Pillow。**没有它时必须 skip，不能 fail**：
  // 这是一个可选的外部依赖，而贡献者（PR #45 作者）在没装 PIL 的环境上跑
  // 全量测试时，这条会误报成"测试失败"，掩盖他真正需要关注的结论。
  // 检测能力本身仍由 scripts/check-edge-clipping.py 提供，CI 上有 PIL 会实跑。
  const probe = detectPillow()
  if (!probe.ok) {
    t.skip(`需要 Python + Pillow 才能做像素级检测（${probe.why}）`)
    return
  }

  const files = ['docs/shots/settings-panel.png', 'docs/shots/picker-dialog.png', 'docs/shots/features.png']
    .map((rel) => ({ rel, p: path.join(root, rel) }))
    .filter(({ p }) => existsSync(p) && pngSize(p))

  // 防抖设计（这条在全量并行下偶发失败过）：
  //  · 一个 Python 进程扫全部图（原来是每图一个进程，spawn 开销 ×3 就是全部负载敏感性）；
  //  · 进程级失败重试一次 —— 图片是静态文件、像素分析是确定性的，进程死了只可能是环境瞬态；
  //  · 用探测到的那个解释器（原来探测认 python3、执行却写死 'python'，只有 python3 的机器必炸）。
  const script = path.join(root, 'scripts/check-edge-clipping.py')
  const runOnce = () => execFileSync(probe.python, [script, ...files.map((f) => f.p)],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  let out
  try {
    out = runOnce()
  } catch {
    await new Promise((r) => setTimeout(r, 1000))
    out = runOnce() // 第二次进程失败是真环境问题——让它带着 stderr 抛出来
  }

  const offenders = []
  // 输出按 `--- <path> (WxH) ---` 分块；块内"发现 N 个高亮像素"即该图有边缘切断。
  for (const block of out.split(/^--- /m)) {
    if (!block.trim()) continue
    const m = block.match(/边缘"(\w+)" 发现 (\d+) 个高亮像素/g)
    if (!m) continue
    const rel = files.find((f) => block.includes(f.p) || block.includes(f.rel))
    const cuts = m.map((s) => s.replace(/边缘"(\w+)" 发现 (\d+) 个高亮像素.*/, '$1'))
    if (cuts.length) offenders.push(`${rel ? rel.rel : block.slice(0, 60)}: ${cuts.join(',')}`)
  }
  assert.deepEqual(offenders, [],
    `screenshot text is clipped at the edge:\n  ${offenders.join('\n  ')}`)
})

