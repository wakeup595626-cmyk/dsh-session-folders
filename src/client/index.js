/**
 * @dsh-external/dsh-session-folders — client 半（纯 DOM 增强，零依赖）。
 *
 * 在会话列表（ui-workspace 的 treeBody）顶部注入"分组"区块：
 *  - 文件夹树（嵌套、自定义颜色/图标、折叠记忆）
 *  - 已分组会话从原生列表隐藏，在文件夹内以自有行渲染（点击 ctx.sessions.open 打开）
 *  - 三种归组交互：右键菜单「移动到分组」、拖拽会话到文件夹、批量选择模式
 *  - 状态经 host REST API 持久化（~/.dsh/profiles/web/session-folders.json）
 *
 * 数据源：ctx.sessions.list（标题/状态/当前会话）、ctx.workspaces.list（归档集合）。
 * DOM→sessionId 映射：沿 __reactFiber$ 链向上找带 {node:{id}, onOpen} 的 props。
 *
 * 本文件按 CJS 风格书写（exports.*），由 scripts/build-client.mjs 包上
 * window.__ModuleLoader__ 头尾即为 lib/client.js，无需 tsdown。
 */
'use strict'

exports.inject = ['slots', 'sessions', 'workspaces']

const API = '/@dsh-external/dsh-session-folders/api'
const HIDE_CLS = 'dsf-hidden'

const COLOR_PRESETS = ['', '#e05252', '#e08a3c', '#d9b73c', '#4caf7d', '#3aa9a4', '#4f8ef7', '#9b6ef3', '#e06ea8', '#8a8f98']
const COLOR_NAMES = ['默认', '红', '橙', '黄', '绿', '青', '蓝', '紫', '粉', '灰']
const ICON_PRESETS = ['', '📁', '🧩', '💼', '📚', '🧪', '🛠️', '💡', '🗂️', '⭐', '🔥', '📝', '🎯', '🤖', '📦', '🐛']

// ---------- 模块状态 ----------
let app = null
let state = { version: 0, folders: [], memberships: {} }
let summaries = {}          // sessionId -> SessionSummary
let archivedIds = new Set()
let currentId = undefined
let selectMode = false
const selected = new Set()
const selectedFolders = new Set()
const sections = new Map()   // groupKey（'' = 未分组区）-> { el, wsId }
const wsLabels = new Map()   // groupKey -> 工作区显示名（菜单里标注文件夹归属用）
let sessionWs = new Map()    // sessionId -> workspaceId|null（由 projectRow fiber 扫描重建）
let pendingRowMenu = null    // { sid, at, rect } —— 原生 ⋯ 菜单注入用
let lastSig = '¡init!'
let currentDrag = null      // { id, from } 会话拖拽 | { folder } 文件夹拖拽
let menuEl = null
let dialogEl = null
let dshCtx = null          // cordis ctx（新建会话用）
let toastTimer = 0
const rowCache = new WeakMap()
let syncTimer = 0
let expandTimer = 0

// ---------- 小工具 ----------
function h(tag, cls, text) {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text != null) el.textContent = text
  return el
}
function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return 'f-' + crypto.randomUUID()
  return 'f-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}
function debounceSync() {
  if (syncTimer) return
  syncTimer = setTimeout(() => { syncTimer = 0; syncAll(false) }, 60)
}
function toast(msg) {
  document.querySelectorAll('.dsf-toast').forEach((el) => el.remove())
  const el = h('div', 'dsf-toast', msg)
  document.body.append(el)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.remove(), 2200)
}

// ---------- 数据访问 ----------
function folderById(id) { return state.folders.find((f) => f.id === id) }
function childFolders(pid) {
  return state.folders.filter((f) => f.parentId === pid).sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
}
function isDescendantOf(fid, ancestorId) {
  let cur = fid
  const seen = new Set()
  while (cur && !seen.has(cur)) {
    if (cur === ancestorId) return true
    seen.add(cur)
    cur = folderById(cur)?.parentId ?? null
  }
  return false
}
function visibleSessionIds(folder) {
  const out = []
  for (const sid of folder.sessionOrder) {
    const s = summaries[sid]
    if (!s) continue
    // blank（刚新建的空会话）要显示——否则「在文件夹里新建对话」看不见成果
    if (s.origin === 'subagent') continue
    if (archivedIds.has(sid)) continue
    out.push(sid)
  }
  return out
}
function sessionTitle(sid) {
  const s = summaries[sid]
  if (s && s.blank) return '✏️ 新对话（输入内容即开始）'
  return (s && (s.displayTitle || s.title)) || '（会话不可用）'
}
function pullServiceData() {
  try {
    const snap = app.sessions.list.getSnapshot()
    summaries = (snap && snap.byId) || {}
    currentId = snap ? snap.current : undefined
  } catch { /* 服务未就绪 */ }
  try {
    const ws = app.workspaces.list.getSnapshot()
    archivedIds = new Set((ws && ws.archivedSessionIds) || [])
  } catch { /* 服务未就绪 */ }
}

// ---------- API ----------
async function loadState(retries) {
  for (let i = 0; i < (retries || 4); i++) {
    try {
      const r = await fetch(API + '/state', { credentials: 'same-origin' })
      if (r.ok) {
        const j = await r.json()
        if (j && Array.isArray(j.folders)) { state = j; return true }
      }
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 800 * (i + 1)))
  }
  return false
}
async function apiOp(op) {
  try {
    const r = await fetch(API + '/op', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: state.version, op }),
    })
    const j = await r.json().catch(() => null)
    if (r.status === 409 && j && Array.isArray(j.folders)) {
      state = j
      syncAll(true)
      return { ok: false, conflict: true }
    }
    if (!r.ok) return { ok: false, error: (j && j.error) || ('HTTP ' + r.status) }
    if (j && Array.isArray(j.folders)) state = j
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
async function moveSessions(ids, folderId, beforeId) {
  const r = await apiOp({ type: 'sessions.move', sessionIds: ids, folderId: folderId || null, beforeId })
  if (r.ok) {
    toast(folderId ? '已移入「' + (folderById(folderId)?.name || '') + '」' : '已移出分组')
  } else {
    toast(r.conflict ? '数据已在别处更新，请重试' : '操作失败：' + (r.error || '未知错误'))
  }
  syncAll(true)
  return r.ok
}

// ---------- React fiber → sessionId ----------
function sessionIdOfRow(row) {
  if (rowCache.has(row)) return rowCache.get(row)
  let id = null
  try {
    const key = Object.keys(row).find((k) => k.startsWith('__reactFiber$'))
    let f = key ? row[key] : null
    let hops = 0
    while (f && hops++ < 60) {
      const p = f.memoizedProps
      if (p && p.node && typeof p.node.id === 'string' && typeof p.onOpen === 'function') { id = p.node.id; break }
      f = f.return
    }
  } catch { /* ignore */ }
  rowCache.set(row, id)
  return id
}

/** projectRow fiber → 工作区分组信息（ui-workspace ProjectRowItem 的 props.group）。
 *  注意：绝不缓存——props.group.sessions 随数据加载/展开变化，缓存会把"空会话列表"固化成永恒。 */
function groupInfoOfRow(row) {
  let info = null
  try {
    const key = Object.keys(row).find((k) => k.startsWith('__reactFiber$'))
    let f = key ? row[key] : null
    let hops = 0
    while (f && hops++ < 60) {
      const p = f.memoizedProps
      if (p && p.group && typeof p.group === 'object' && Array.isArray(p.group.sessions)) {
        const g = p.group
        info = {
          key: typeof g.key === 'string' ? g.key : '',
          wsId: typeof g.workspaceId === 'string' && g.workspaceId ? g.workspaceId : null,
          label: typeof g.label === 'string' ? g.label : '',
          sessionIds: g.sessions.map((s) => s && s.id).filter(Boolean),
        }
        break
      }
      f = f.return
    }
  } catch { /* ignore */ }
  return info
}

/** 文件夹所属工作区（子文件夹继承祖先的）。 */
function folderWsId(f) {
  let cur = f
  const seen = new Set()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (!cur.parentId) return cur.workspaceId || null
    cur = folderById(cur.parentId)
  }
  return null
}

// ---------- 挂载点（每个工作区分组块下各挂一个分组区） ----------
function findTreeBody() {
  return document.querySelector('div[class*="_treeBody"]')
}
/** 扫描原生行：为每个工作区头部行（projectRow）就地挂载/复用我的分组区。 */
function ensureSections() {
  const tb = findTreeBody()
  if (!tb) return null
  const seenKeys = new Set()
  sessionWs = new Map()
  const rows = tb.querySelectorAll('[role="treeitem"]')
  for (const row of rows) {
    const g = groupInfoOfRow(row)
    if (!g) continue
    for (const sid of g.sessionIds) sessionWs.set(sid, g.wsId)
    const K = g.key
    if (seenKeys.has(K)) continue
    seenKeys.add(K)
    wsLabels.set(K, g.label || '未分组')
    const hasFolders = state.folders.some((f) => folderWsId(f) === g.wsId)
    if (g.wsId === null && !hasFolders) continue // 未分组区：有内容才显示
    let entry = sections.get(K)
    if (!entry) {
      const el = h('div', 'dsf-section')
      el.dataset.dsfWs = K
      buildSection(el, g.wsId)
      entry = { el, wsId: g.wsId }
      sections.set(K, entry)
      lastSig = '¡remount!' // 新元素是空的 → 强制渲染
    }
    entry.wsId = g.wsId
    if (entry.el.previousElementSibling !== row) {
      row.insertAdjacentElement('afterend', entry.el)
      lastSig = '¡remount!'
    }
  }
  // 工作区消失 → 摘除对应区块
  for (const [K, entry] of sections) {
    if (!seenKeys.has(K)) { entry.el.remove(); sections.delete(K) }
  }
  return tb
}

// ---------- 原生行同步（隐藏已分组 + 批量模式复选框） ----------
function syncNativeRows() {
  const tb = ensureSections()
  if (!tb) return
  const rows = tb.querySelectorAll('[role="treeitem"]')
  rows.forEach((row) => {
    const id = sessionIdOfRow(row)
    if (!id) {
      // 「未分组」工作区行整区隐藏（游离会话仍在数据里，只是不进侧栏）
      const g = groupInfoOfRow(row)
      if (g && g.key === '') row.classList.add(HIDE_CLS)
      return
    }
    if (sessionWs.size > 0 && !sessionWs.has(id)) { row.classList.add(HIDE_CLS); return } // 未分组区会话行隐藏（映射为空时宁显示不误伤）
    // 分组视图下原生会话行默认不可拖（drag prop 缺省）→ 强制开启，拖拽归组才能用
    if (!row.draggable) row.draggable = true
    const assigned = !!state.memberships[id]
    row.classList.toggle(HIDE_CLS, assigned)
    const wantCheck = selectMode && !assigned && summaries[id] && !summaries[id].blank
    let check = row.querySelector(':scope > .dsf-check')
    if (wantCheck) {
      if (!check) {
        check = h('span', 'dsf-check dsf-show')
        row.append(check)
      }
      check.classList.toggle('dsf-checked', selected.has(id))
    } else if (check) {
      check.remove()
    }
  })
  // 「收起 / 展开其余 N 个会话」按钮隐藏（保持全展开即可，按钮碍眼）
  tb.querySelectorAll('button[aria-expanded]:not([role="treeitem"])').forEach((b) => b.classList.add(HIDE_CLS))
}

/** 统一同步入口：挂区块 → 隐藏/复选框 → 渲染。 */
function syncAll(force) {
  if (!ensureSections()) return
  syncNativeRows()
  render(force === true)
}

// ---------- 渲染 ----------
function computeSig() {
  const parts = [state.version, currentId || '', selectMode ? 1 : 0]
  for (const sid of Object.keys(state.memberships)) {
    const s = summaries[sid]
    if (!s) continue
    parts.push(sid + ':' + (s.displayTitle || '') + ':' + (s.running ? 1 : 0) + ':' + (s.completed ? 1 : 0) + ':' + (s.blank ? 1 : 0) + ':' + (archivedIds.has(sid) ? 1 : 0))
  }
  return parts.join('|')
}

function render(force) {
  if (sections.size === 0) return
  const sig = computeSig()
  if (!force && sig === lastSig) return
  lastSig = sig
  let first = true
  for (const entry of sections.values()) {
    renderSection(entry, first)
    first = false
  }
}

function renderSection(entry, isFirst) {
  const sectionEl = entry.el
  const wsId = entry.wsId
  sectionEl.textContent = ''

  // 批量选择条（全局一个，放首个区块）
  if (selectMode && isFirst) sectionEl.append(renderSelectBar())

  // 本工作区的顶层文件夹树（直接挂在工作区标题下，无额外表头）
  const roots = childFolders(null).filter((f) => folderWsId(f) === wsId)
  if (roots.length === 0) {
    if (isFirst && state.folders.length === 0) {
      const hint = h('div', 'dsf-hint')
      const cta = h('button', 'dsf-link-btn', '＋ 新建文件夹')
      cta.type = 'button'
      cta.dataset.dsfAct = 'new-folder'
      hint.append(cta)
      hint.append(h('span', 'dsf-hint-sub', '也可以：右键工作区名 / 右键会话 / 点会话 ⋯'))
      sectionEl.append(hint)
    }
  } else {
    const tree = h('div', 'dsf-tree')
    for (const f of roots) tree.append(renderFolder(f, 0))
    sectionEl.append(tree)
  }

  // 文件夹拖拽时的「移到顶层」区（仅拖文件夹时可见）
  const topzone = h('div', 'dsf-topzone', '⬆ 移到此处：与其它文件夹同级')
  topzone.dataset.dsfAct = 'top-zone'
  sectionEl.append(topzone)

  // 拖出分组回收区（仅拖拽会话时可见）
  const ungroup = h('div', 'dsf-ungroup-zone', '移到此处退出分组')
  ungroup.dataset.dsfAct = 'ungroup-zone'
  sectionEl.append(ungroup)
}

function renderSelectBar() {
  const bar = h('div', 'dsf-selectbar')
  bar.append(h('span', 'dsf-select-count', '已选 ' + selectedCount() + ' 项'))
  const sel = h('select', 'dsf-select')
  const optTop = h('option', '', '移动到…')
  optTop.value = ''
  sel.append(optTop)
  const addOpts = (pid, depth) => {
    for (const f of childFolders(pid)) {
      const o = h('option', '', '　'.repeat(depth) + (f.icon || '📁') + ' ' + f.name)
      o.value = f.id
      sel.append(o)
      addOpts(f.id, depth + 1)
    }
  }
  addOpts(null, 0)
  sel.dataset.dsfAct = 'select-target'
  const moveBtn = h('button', 'dsf-btn', '移入')
  moveBtn.type = 'button'
  moveBtn.dataset.dsfAct = 'select-move'
  const newBtn = h('button', 'dsf-btn', '新建并移入')
  newBtn.type = 'button'
  newBtn.dataset.dsfAct = 'select-move-new'
  const delBtn = h('button', 'dsf-btn dsf-btn-danger', '删除')
  delBtn.type = 'button'
  delBtn.dataset.dsfAct = 'select-archive'
  const doneBtn = h('button', 'dsf-btn dsf-btn-ghost', '完成')
  doneBtn.type = 'button'
  doneBtn.dataset.dsfAct = 'toggle-select'
  bar.append(sel, moveBtn, newBtn, delBtn, doneBtn)
  return bar
}

function hexTint(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return null
  const n = parseInt(m[1], 16)
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')'
}
function renderFolder(f, depth) {
  const frag = document.createDocumentFragment()
  const kids = childFolders(f.id)
  const sids = f.collapsed ? [] : visibleSessionIds(f)
  const total = visibleSessionIds(f).length

  const row = h('div', 'dsf-frow')
  row.dataset.dsfFolder = f.id
  row.style.setProperty('--dsf-depth', String(depth))
  if (depth > 0) row.classList.add('dsf-guide')
  row.title = f.name // 名字过长截断时，悬停显示全名
  // 文件夹行铺一层淡淡的本色底色（替代原色点，避免和"运行中"圆点混淆）
  const tint = f.color ? hexTint(f.color, 0.12) : 'rgba(127,127,127,0.10)'
  const tintHover = f.color ? hexTint(f.color, 0.22) : 'rgba(127,127,127,0.16)'
  row.style.setProperty('--dsf-tint', tint)
  row.style.setProperty('--dsf-tint-hover', tintHover)
  row.draggable = true
  const arrow = h('span', 'dsf-arrow', f.collapsed ? '▸' : '▾')
  row.append(arrow)
  if (f.icon) row.append(h('span', 'dsf-ficon', f.icon))
  row.append(h('span', 'dsf-title', f.name))
  row.append(h('span', 'dsf-count', String(total)))
  const add = h('button', 'dsf-icon-btn dsf-row-new', '＋')
  add.type = 'button'
  add.title = '在此文件夹里新建对话'
  add.dataset.dsfAct = 'session-new'
  add.dataset.dsfFolder = f.id
  row.append(add)
  const more = h('button', 'dsf-icon-btn dsf-row-menu', '⋯')
  more.type = 'button'
  more.title = '文件夹操作'
  more.dataset.dsfAct = 'folder-menu'
  more.dataset.dsfFolder = f.id
  row.append(more)
  row.append(h('span', 'dsf-check' + (selectedFolders.has(f.id) ? ' dsf-checked' : '')))
  frag.append(row)

  if (!f.collapsed) {
    const body = h('div', 'dsf-fbody')
    // 子级行里那条竖线用当前文件夹的颜色（子文件夹会再覆盖成自己的颜色）
    body.style.setProperty('--dsf-guide-color', f.color ? (hexTint(f.color, 0.5) || 'rgba(127,127,127,.28)') : 'rgba(127,127,127,.28)')
    for (const cf of kids) body.append(renderFolder(cf, depth + 1))
    for (const sid of sids) body.append(renderSessionRow(sid, f.id, depth + 1))
    if (kids.length === 0 && sids.length === 0) {
      const empty = h('div', 'dsf-empty', '空分组：把会话拖到这里，或右键会话移入')
      empty.style.setProperty('--dsf-depth', String(depth + 1))
      body.append(empty)
    }
    frag.append(body)
  }
  return frag
}

function renderSessionRow(sid, fid, depth) {
  const s = summaries[sid] || {}
  const row = h('div', 'dsf-srow')
  row.dataset.dsfSession = sid
  row.dataset.dsfFolder = fid
  row.style.setProperty('--dsf-depth', String(depth))
  row.classList.add('dsf-guide')
  row.draggable = true
  if (sid === currentId) row.classList.add('dsf-current')
  const dot = h('span', 'dsf-status')
  if (s.running) dot.classList.add('dsf-run')
  else if (s.completed) dot.classList.add('dsf-done')
  row.append(dot)
  row.append(h('span', 'dsf-title', sessionTitle(sid)))
  const menuBtn = h('button', 'dsf-icon-btn dsf-row-menu', '⋯')
  menuBtn.type = 'button'
  menuBtn.title = '分组操作'
  menuBtn.dataset.dsfAct = 'session-menu'
  row.append(menuBtn)
  const check = h('span', 'dsf-check' + (selected.has(sid) ? ' dsf-checked' : ''))
  row.append(check)
  return row
}

// ---------- 右键菜单 ----------
let submenuFor = null
function closeMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null }
  document.querySelectorAll('.dsf-submenu').forEach((el) => el.remove())
  submenuFor = null
}
function showMenu(x, y, items) {
  closeMenu()
  menuEl = h('div', 'dsf-menu')
  for (const it of items) {
    if (it.sep) { menuEl.append(h('div', 'dsf-menu-sep')); continue }
    const mi = h('div', 'dsf-menu-item' + (it.danger ? ' dsf-danger' : '') + (it.disabled ? ' dsf-disabled' : ''))
    mi.append(h('span', 'dsf-menu-label', it.label))
    if (it.submenu) mi.append(h('span', 'dsf-menu-arrow', '▸'))
    if (!it.disabled) {
      mi.addEventListener('click', (e) => {
        e.stopPropagation()
        if (it.submenu) { toggleSubmenu(mi, it.submenu); return }
        closeMenu()
        if (it.action) it.action()
      })
    }
    menuEl.append(mi)
  }
  document.body.append(menuEl)
  const r = menuEl.getBoundingClientRect()
  menuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px'
  menuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + 'px'
}
function toggleSubmenu(parentItem, items) {
  document.querySelectorAll('.dsf-submenu').forEach((el) => el.remove())
  if (submenuFor === parentItem) { submenuFor = null; return } // 再点一次收起
  submenuFor = parentItem
  const sub = h('div', 'dsf-menu dsf-submenu')
  for (const it of items) {
    if (it.sep) { sub.append(h('div', 'dsf-menu-sep')); continue }
    const mi = h('div', 'dsf-menu-item' + (it.danger ? ' dsf-danger' : '') + (it.disabled ? ' dsf-disabled' : ''))
    mi.append(h('span', 'dsf-menu-label', it.label))
    if (!it.disabled) {
      mi.addEventListener('click', (e) => {
        e.stopPropagation()
        closeMenu()
        if (it.action) it.action()
      })
    }
    sub.append(mi)
  }
  // 挂 body + fixed 定位：菜单容器 overflow 会裁掉内部绝对定位的子菜单（此前"点击无反应"的根因）
  document.body.append(sub)
  const r = parentItem.getBoundingClientRect()
  const sr = sub.getBoundingClientRect()
  let left = r.right - 2
  if (left + sr.width > window.innerWidth - 8) left = r.left - sr.width + 2
  sub.style.left = Math.max(4, left) + 'px'
  sub.style.top = Math.max(4, Math.min(r.top - 4, window.innerHeight - sr.height - 8)) + 'px'
}
function folderPickItems(onPick, includeNew, wsId) {
  // wsId：string=该工作区的文件夹；null=确定属未分组区；undefined=归属未知 → 不过滤，显示全部
  const items = []
  if (includeNew !== false) {
    items.push({ label: '＋ 新建文件夹…', action: () => openFolderDialog({ mode: 'create', workspaceId: wsId || null, onSaved: (fid) => onPick(fid) }) })
  }
  const wantWs = wsId === undefined ? undefined : (wsId || null)
  const multiScope = new Set(state.folders.filter((f) => !f.parentId).map((f) => folderWsId(f))).size > 1
  const walk = (pid, depth, filter) => {
    for (const f of childFolders(pid)) {
      if (filter && pid === null && wantWs !== undefined && folderWsId(f) !== wantWs) continue
      let label = '　'.repeat(depth) + (f.icon || '📁') + ' ' + f.name
      if (pid === null && multiScope) label += ' 〈' + (wsLabels.get(folderWsId(f) || '') || '未分组') + '〉'
      items.push({ label, action: () => onPick(f.id) })
      walk(f.id, depth + 1, filter)
    }
  }
  walk(null, 0, true)
  // 过滤后一个文件夹都没有 → 降级显示全部（避免"目标文件夹看不到"的死角）
  if (wantWs !== undefined && items.length === (includeNew !== false ? 1 : 0) && state.folders.length > 0) {
    items.length = includeNew !== false ? 1 : 0
    walk(null, 0, false)
  }
  if (items.length === (includeNew !== false ? 1 : 0)) items.push({ label: '（还没有文件夹）', disabled: true })
  return items
}
/** 归档（删除）会话：同时清掉分组归属。归档后从所有列表消失。 */
async function archiveSessions(ids) {
  if (!dshCtx || !dshCtx.workspaces || typeof dshCtx.workspaces.archiveSession !== 'function') {
    toast('当前环境不支持归档')
    return false
  }
  let okCount = 0
  for (const sid of ids) {
    try {
      await dshCtx.workspaces.archiveSession(sid)
      if (state.memberships[sid]) await apiOp({ type: 'sessions.move', sessionIds: [sid], folderId: null })
      okCount++
    } catch (err) {
      console.warn('dsh-session-folders: archive', sid, err)
    }
  }
  pullServiceData()
  render(true)
  toast('已删除 ' + okCount + ' 个会话')
  return okCount > 0
}

/** 重命名对话（走原生 sessions 服务的 rename，与原生菜单同一条链路） */
async function renameSessionInteractive(sid) {
  const s = summaries[sid]
  const cur = s && s.blank ? '' : sessionTitle(sid)
  const name = prompt('重命名对话', cur)
  if (name === null) return
  const trimmed = name.trim()
  if (!trimmed || trimmed === cur) return
  try {
    const session = dshCtx && dshCtx.sessions && dshCtx.sessions.binding(sid) && dshCtx.sessions.binding(sid).session
    if (!session || typeof session.rename !== 'function') { toast('当前环境不支持重命名'); return }
    const result = await session.rename(trimmed)
    if (!result || !result.ok) { toast('重命名失败：' + ((result && result.error && result.error.message) || '未知错误')); return }
    pullServiceData()
    render(true)
    toast('已重命名为「' + trimmed + '」')
  } catch (e) { toast('重命名失败：' + String(e)) }
}

function openSessionMenu(x, y, sid) {
  const assigned = state.memberships[sid]
  const blank = summaries[sid] && summaries[sid].blank
  const items = []
  items.push({ label: '✏️ 重命名', action: () => renameSessionInteractive(sid) })
  if (!blank) {
    items.push({ label: '移动到分组', submenu: folderPickItems((fid) => moveSessions([sid], fid), true, sessionWs.get(sid)) })
    if (assigned) items.push({ label: '移出分组', action: () => moveSessions([sid], null) })
  }
  items.push({ label: '批量选择模式', action: () => setSelectMode(true) })
  items.push({ sep: true })
  items.push({ label: '🗑 删除会话', danger: true, action: () => archiveSessions([sid]) })
  showMenu(x, y, items)
}
function openFolderMenu(x, y, fid) {
  const f = folderById(fid)
  if (!f) return
  const items = [
    { label: '➕ 在此新建对话', action: () => newSessionInFolder(fid) },
    { label: '新建子文件夹', action: () => openFolderDialog({ mode: 'create', presetParent: fid }) },
    { label: '📂 移动到…', submenu: folderMovePickItems(fid) },
    { label: '重命名 / 配色 / 图标', action: () => openFolderDialog({ mode: 'edit', folder: f }) },
  ]
  if (f.parentId) {
    items.push({
      label: '⬆ 移到顶层（与其它文件夹同级）',
      action: () => apiOp({ type: 'folder.update', id: fid, patch: { parentId: null } }).then((r) => {
        if (r.ok) toast('已移到顶层')
        render(true)
      }),
    })
  }
  items.push({ label: '☑ 批量选择', action: () => setSelectMode(true) })
  items.push({ sep: true })
  items.push({ label: '删除分组', danger: true, action: () => openDeleteConfirm(f) })
  showMenu(x, y, items)
}
/** 在指定文件夹里直接新建一个对话（自动归入该文件夹并打开）。 */
async function newSessionInFolder(fid) {
  const f = folderById(fid)
  if (!f) return
  const wsId = folderWsId(f)
  if (!wsId) { toast('未分组区的文件夹不支持新建对话'); return }
  if (!dshCtx || !dshCtx.sessions || typeof dshCtx.sessions.create !== 'function') { toast('当前环境不支持直接新建'); return }
  try {
    const sid = await dshCtx.sessions.create({ workspaceId: wsId })
    if (!sid) throw new Error('no session id')
    // 插到文件夹最上面（新对话应该第一眼看到）
    const first = f.sessionOrder[0]
    await apiOp({ type: 'sessions.move', sessionIds: [sid], folderId: fid, beforeId: first })
    if (f.collapsed) await apiOp({ type: 'folder.update', id: fid, patch: { collapsed: false } })
    try { dshCtx.sessions.open(sid) } catch { /* ignore */ }
    render(true)
    toast('已在「' + f.name + '」里新建对话')
  } catch (err) {
    console.warn('dsh-session-folders: newSessionInFolder', err)
    toast('新建失败：' + (err && err.message ? err.message : String(err)))
  }
}

/** 工作区标题（projectRow）右键：在这里新建文件夹。 */
function openWorkspaceMenu(x, y, wsId, wsLabel) {
  showMenu(x, y, [
    { label: '📁 新建文件夹…', action: () => openFolderDialog({ mode: 'create', workspaceId: wsId }) },
    { label: '☑ 批量选择模式', action: () => setSelectMode(true) },
  ])
}

// ---------- 原生 ⋯ 菜单注入 ----------
function injectNativeMenuItems(menuRoot) {
  const pm = pendingRowMenu
  if (!pm) return
  const items = menuRoot.querySelectorAll('button[role="menuitem"]')
  if (items.length === 0) return
  // 工作区 ⋯ 菜单：注入「新建文件夹」
  if (pm.ws) {
    const ws = pm.ws
    const rect = pm.rect
    const sampleWrap = items[items.length - 1].parentElement
    const clone = sampleWrap.cloneNode(true)
    const btn = clone.querySelector('button[role="menuitem"]') || clone.firstElementChild
    if (!btn) return
    const spans = btn.querySelectorAll('span')
    if (spans[0]) spans[0].textContent = '📁'
    const labelSpan = spans.length > 1 ? spans[spans.length - 1] : null
    if (labelSpan) labelSpan.textContent = '新建文件夹…'
    else btn.append(h('span', '', '新建文件夹…'))
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      pendingRowMenu = null
      openFolderDialog({ mode: 'create', workspaceId: ws.wsId })
    }, true)
    ;(menuRoot.firstElementChild || menuRoot).append(clone)
    return
  }
  const sid = pm.sid
  const s = summaries[sid]
  const assigned = !!state.memberships[sid]
  const wsId = sessionWs.has(sid) ? sessionWs.get(sid) : undefined // undefined=归属未知 → 列表不过滤
  const rect = pm.rect
  const sampleWrap = items[items.length - 1].parentElement

  const makeItem = (icon, label, onClick, disabled) => {
    const clone = sampleWrap.cloneNode(true)
    const btn = clone.querySelector('button[role="menuitem"]') || clone.firstElementChild
    if (!btn) return null
    const spans = btn.querySelectorAll('span')
    if (spans[0]) spans[0].textContent = icon // 图标位（替换 svg）
    const labelSpan = spans.length > 1 ? spans[spans.length - 1] : null
    if (labelSpan) labelSpan.textContent = label
    else btn.append(h('span', '', label))
    if (disabled) btn.style.opacity = '.45'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (disabled) return
      // 关掉原生菜单，再执行动作
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      pendingRowMenu = null
      onClick()
    }, true)
    return clone
  }

  if (s && s.blank) {
    const it = makeItem('🗂', '空白会话不能归组', () => {}, true)
    if (it) menuRoot.firstElementChild ? menuRoot.firstElementChild.append(it) : menuRoot.append(it)
    return
  }
  const container = menuRoot.firstElementChild || menuRoot
  if (assigned) {
    const out = makeItem('📤', '移出分组', () => { moveSessions([sid], null) })
    if (out) container.append(out)
  }
  const mv = makeItem('🗂', '移动到分组…', () => {
    showMenu(rect.left, rect.bottom + 6, folderPickItems((fid) => moveSessions([sid], fid), true, wsId))
  })
  if (mv) container.append(mv)
  if (!selectMode) {
    const bs = makeItem('☑', '批量选择模式', () => { setSelectMode(true) })
    if (bs) container.append(bs)
  }
}

// ---------- 对话框 ----------
function closeDialog() {
  if (dialogEl) { dialogEl.remove(); dialogEl = null }
}
function folderOptions(selectEl, excludeId, presetParent, wsId) {
  const top = h('option', '', '（顶层）')
  top.value = ''
  selectEl.append(top)
  const wantWs = wsId || null
  const walk = (pid, depth) => {
    for (const f of childFolders(pid)) {
      if (pid === null && folderWsId(f) !== wantWs) continue
      if (excludeId && (f.id === excludeId || isDescendantOf(f.id, excludeId))) continue
      const o = h('option', '', '　'.repeat(depth) + (f.icon || '📁') + ' ' + f.name)
      o.value = f.id
      selectEl.append(o)
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  selectEl.value = presetParent || ''
}
function openFolderDialog(opts) {
  closeDialog()
  closeMenu()
  const isEdit = opts.mode === 'edit' && opts.folder
  const folder = isEdit ? opts.folder : null
  // 归属工作区：编辑沿用原值；新建 = 父文件夹继承 或 显式传入
  const effWsId = isEdit ? folderWsId(folder) : (opts.presetParent ? folderWsId(folderById(opts.presetParent)) : (opts.workspaceId || null))
  let pickedColor = folder ? folder.color : '#4f8ef7'
  let pickedIcon = folder ? folder.icon : '📁'

  const overlay = h('div', 'dsf-overlay')
  const card = h('div', 'dsf-dialog')
  const closeX = h('button', 'dsf-dialog-close', '✕')
  closeX.type = 'button'
  closeX.title = '关闭'
  closeX.addEventListener('click', closeDialog)
  card.append(closeX, h('div', 'dsf-dialog-title', isEdit ? '编辑文件夹' : '新建文件夹'))

  const nameLabel = h('label', 'dsf-field-label', '名称')
  const nameInput = h('input', 'dsf-input')
  nameInput.type = 'text'
  nameInput.maxLength = 60
  nameInput.placeholder = '例如：插件开发'
  nameInput.value = folder ? folder.name : ''

  const parentLabel = h('label', 'dsf-field-label', '上级文件夹')
  const parentSel = h('select', 'dsf-input dsf-select-full')
  folderOptions(parentSel, folder ? folder.id : null, folder ? folder.parentId : (opts.presetParent || ''), effWsId)

  const colorLabel = h('label', 'dsf-field-label', '颜色')
  const swatches = h('div', 'dsf-swatches')
  const refreshSwatches = () => {
    swatches.querySelectorAll('.dsf-swatch').forEach((el) => {
      el.classList.toggle('dsf-on', el.dataset.dsfColor === pickedColor)
    })
  }
  COLOR_PRESETS.forEach((c, i) => {
    const sw = h('button', 'dsf-swatch')
    sw.type = 'button'
    sw.title = COLOR_NAMES[i]
    sw.dataset.dsfColor = c
    if (c) sw.style.background = c
    else sw.classList.add('dsf-swatch-none')
    sw.addEventListener('click', () => { pickedColor = c; customColor.value = c || '#4f8ef7'; refreshSwatches() })
    swatches.append(sw)
  })
  const customColor = h('input', 'dsf-color-input')
  customColor.type = 'color'
  customColor.title = '自定义颜色'
  customColor.value = pickedColor || '#4f8ef7'
  customColor.addEventListener('input', () => { pickedColor = customColor.value; refreshSwatches() })
  swatches.append(customColor)

  const iconLabel = h('label', 'dsf-field-label', '图标')
  const icons = h('div', 'dsf-icons')
  const refreshIcons = () => {
    icons.querySelectorAll('.dsf-icon-pick').forEach((el) => {
      el.classList.toggle('dsf-on', el.dataset.dsfIcon === pickedIcon)
    })
  }
  ICON_PRESETS.forEach((ic) => {
    const b = h('button', 'dsf-icon-pick', ic || '∅')
    b.type = 'button'
    b.dataset.dsfIcon = ic
    b.addEventListener('click', () => { pickedIcon = ic; refreshIcons() })
    icons.append(b)
  })

  const btnRow = h('div', 'dsf-dialog-btns')
  const cancel = h('button', 'dsf-btn dsf-btn-ghost', '取消')
  cancel.type = 'button'
  const save = h('button', 'dsf-btn dsf-btn-primary', isEdit ? '保存' : '创建')
  save.type = 'button'
  btnRow.append(cancel, save)

  card.append(nameLabel, nameInput, parentLabel, parentSel, colorLabel, swatches, iconLabel, icons, btnRow)
  overlay.append(card)
  dialogEl = overlay
  document.body.append(overlay)
  refreshSwatches()
  refreshIcons()
  nameInput.focus()

  cancel.addEventListener('click', closeDialog)
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeDialog() })
  save.addEventListener('click', async () => {
    const name = nameInput.value.trim()
    if (!name) { nameInput.focus(); nameInput.classList.add('dsf-input-error'); return }
    const parentId = parentSel.value || null
    if (isEdit) {
      const r = await apiOp({ type: 'folder.update', id: folder.id, patch: { name, parentId, color: pickedColor, icon: pickedIcon } })
      if (r.ok) { closeDialog(); toast('已保存') } else { toast(r.conflict ? '数据已在别处更新，请重试' : '保存失败：' + (r.error || '')) }
    } else {
      const siblings = childFolders(parentId)
      const nf = {
        id: genId(), name, parentId, color: pickedColor, icon: pickedIcon,
        workspaceId: parentId ? folderWsId(folderById(parentId)) : effWsId,
        order: siblings.length, collapsed: false, sessionOrder: [],
      }
      const r = await apiOp({ type: 'folder.create', folder: nf })
      if (r.ok) { closeDialog(); toast('已创建「' + name + '」'); if (opts.onSaved) opts.onSaved(nf.id) } else { toast(r.conflict ? '数据已在别处更新，请重试' : '创建失败：' + (r.error || '')) }
    }
    syncAll(true)
  })
}
function openDeleteConfirm(f) {
  closeDialog()
  closeMenu()
  const n = visibleSessionIds(f).length
  const overlay = h('div', 'dsf-overlay')
  const card = h('div', 'dsf-dialog')
  const closeX2 = h('button', 'dsf-dialog-close', '✕')
  closeX2.type = 'button'
  closeX2.title = '关闭'
  closeX2.addEventListener('click', closeDialog)
  card.append(closeX2, h('div', 'dsf-dialog-title', '删除分组'))
  card.append(h('div', 'dsf-dialog-text', '删除「' + f.name + '」？' + (n > 0 ? '其中 ' + n + ' 个对话会移回未分组列表。' : '') + '子文件夹会上移一级。对话本身不会被删除。'))
  const btnRow = h('div', 'dsf-dialog-btns')
  const cancel = h('button', 'dsf-btn dsf-btn-ghost', '取消')
  cancel.type = 'button'
  const del = h('button', 'dsf-btn dsf-btn-danger', '删除')
  del.type = 'button'
  btnRow.append(cancel, del)
  card.append(btnRow)
  overlay.append(card)
  dialogEl = overlay
  document.body.append(overlay)
  cancel.addEventListener('click', closeDialog)
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeDialog() })
  del.addEventListener('click', async () => {
    const r = await apiOp({ type: 'folder.delete', id: f.id })
    closeDialog()
    toast(r.ok ? '已删除分组' : '删除失败：' + (r.error || ''))
    syncAll(true)
  })
}

// ---------- 批量选择 ----------
function setSelectMode(on) {
  selectMode = on
  if (!on) { selected.clear(); selectedFolders.clear() }
  document.body.classList.toggle('dsf-selecting', on)
  syncAll(true)
}
function selectedCount() { return selected.size + selectedFolders.size }
function updateSelectCount() {
  const bar = document.querySelector('.dsf-section .dsf-select-count')
  if (bar) bar.textContent = '已选 ' + selectedCount() + ' 项'
}
function toggleSelected(sid) {
  if (selected.has(sid)) selected.delete(sid)
  else selected.add(sid)
  updateSelectCount()
  // 同步自有行复选框视觉（可能在任意工作区区块内）
  document.querySelectorAll('.dsf-section .dsf-srow[data-dsf-session="' + CSS.escape(sid) + '"] .dsf-check').forEach((c) => {
    c.classList.toggle('dsf-checked', selected.has(sid))
  })
  const tb = findTreeBody()
  if (tb) {
    tb.querySelectorAll('[role="treeitem"]').forEach((row) => {
      if (sessionIdOfRow(row) === sid) {
        const c = row.querySelector(':scope > .dsf-check')
        if (c) c.classList.toggle('dsf-checked', selected.has(sid))
      }
    })
  }
}
function toggleFolderSelected(fid) {
  if (selectedFolders.has(fid)) selectedFolders.delete(fid)
  else selectedFolders.add(fid)
  updateSelectCount()
  document.querySelectorAll('.dsf-section .dsf-frow[data-dsf-folder="' + CSS.escape(fid) + '"] .dsf-check').forEach((c) => {
    c.classList.toggle('dsf-checked', selectedFolders.has(fid))
  })
}
/** 批量：把多个文件夹移入目标文件夹（跳过目标自身及其子孙，避免成环）。 */
async function moveFolders(ids, targetId) {
  const target = folderById(targetId)
  if (!target) { toast('目标文件夹不存在'); return false }
  const valid = ids.filter((fid) => fid !== targetId && !isDescendantOf(targetId, fid))
  if (valid.length === 0) { toast('没有可移动的分组（不能移到自己或自己的子文件夹里）'); return false }
  let okCount = 0
  for (const fid of valid) {
    const r = await apiOp({ type: 'folder.update', id: fid, patch: { parentId: targetId } })
    if (r.ok) okCount++
  }
  if (okCount > 0 && target.collapsed) await apiOp({ type: 'folder.update', id: targetId, patch: { collapsed: false } })
  toast('已移入「' + target.name + '」' + okCount + ' 个分组')
  syncAll(true)
  return okCount > 0
}
/** 批量：删除多个分组（其中的会话移回未分组，对话本身不删）。 */
async function deleteFolders(ids) {
  let okCount = 0
  for (const fid of ids) {
    const r = await apiOp({ type: 'folder.delete', id: fid })
    if (r.ok) okCount++
  }
  pullServiceData()
  syncAll(true)
  toast('已删除 ' + okCount + ' 个分组')
  return okCount > 0
}

// ---------- 区块内事件（委托；每个工作区区块一份） ----------
function buildSection(sectionEl, wsId) {

  sectionEl.addEventListener('click', (e) => {
    const actEl = e.target.closest('[data-dsf-act]')
    if (actEl && sectionEl.contains(actEl)) {
      const act = actEl.dataset.dsfAct
      if (act === 'new-folder') { openFolderDialog({ mode: 'create', workspaceId: wsId }); return }
      if (act === 'toggle-select') { setSelectMode(!selectMode); return }
      if (act === 'folder-menu') {
        e.stopPropagation()
        const r = actEl.getBoundingClientRect()
        openFolderMenu(r.left, r.bottom + 4, actEl.dataset.dsfFolder)
        return
      }
      if (act === 'session-new') {
        e.stopPropagation()
        newSessionInFolder(actEl.dataset.dsfFolder)
        return
      }
      if (act === 'session-menu') {
        e.stopPropagation()
        const srow = actEl.closest('.dsf-srow')
        if (!srow) return
        const r = actEl.getBoundingClientRect()
        openSessionMenu(r.left, r.bottom + 4, srow.dataset.dsfSession)
        return
      }
      if (act === 'select-move') {
        const sel = sectionEl.querySelector('.dsf-select')
        const fid = sel && sel.value
        if (!fid) { toast('先选择目标文件夹'); return }
        if (selectedCount() === 0) { toast('还没有选中任何项'); return }
        const ps = []
        if (selected.size) ps.push(moveSessions([...selected], fid))
        if (selectedFolders.size) ps.push(moveFolders([...selectedFolders], fid))
        Promise.all(ps).then((oks) => { if (oks.length && oks.every(Boolean)) setSelectMode(false) })
        return
      }
      if (act === 'select-move-new') {
        if (selected.size === 0) { toast('还没有选中会话'); return }
        const ids = [...selected]
        openFolderDialog({ mode: 'create', workspaceId: wsId, onSaved: (fid) => { moveSessions(ids, fid).then((ok) => { if (ok) setSelectMode(false) }) } })
        return
      }
      if (act === 'select-archive') {
        const nS = selected.size, nF = selectedFolders.size
        if (nS === 0 && nF === 0) { toast('还没有选中任何项'); return }
        const parts = []
        if (nS) parts.push(nS + ' 个会话')
        if (nF) parts.push(nF + ' 个分组')
        if (!confirm('确定删除选中的 ' + parts.join(' 和 ') + ' 吗？会话会归档消失；分组会删除，其中的会话移回未分组（不会消失）。')) return
        const ps = []
        if (nS) ps.push(archiveSessions([...selected]))
        if (nF) ps.push(deleteFolders([...selectedFolders]))
        Promise.all(ps).then((oks) => { if (oks.length && oks.every(Boolean)) { selected.clear(); selectedFolders.clear(); setSelectMode(false) } })
        return
      }
      return
    }
    const srow = e.target.closest('.dsf-srow')
    if (srow && sectionEl.contains(srow)) {
      const sid = srow.dataset.dsfSession
      if (selectMode) { toggleSelected(sid); return }
      try { app.sessions.open(sid) } catch (err) { console.warn('dsh-session-folders: open 失败', err) }
      return
    }
    const frow = e.target.closest('.dsf-frow')
    if (frow && sectionEl.contains(frow)) {
      const fid = frow.dataset.dsfFolder
      if (selectMode) { toggleFolderSelected(fid); return }
      const f = folderById(fid)
      if (!f) return
      apiOp({ type: 'folder.update', id: fid, patch: { collapsed: !f.collapsed } }).then(() => { render(true) })
    }
  })

  sectionEl.addEventListener('contextmenu', (e) => {
    const srow = e.target.closest('.dsf-srow')
    if (srow && sectionEl.contains(srow)) {
      e.preventDefault(); e.stopPropagation()
      openSessionMenu(e.clientX, e.clientY, srow.dataset.dsfSession)
      return
    }
    const frow = e.target.closest('.dsf-frow')
    if (frow && sectionEl.contains(frow)) {
      e.preventDefault(); e.stopPropagation()
      openFolderMenu(e.clientX, e.clientY, frow.dataset.dsfFolder)
    }
  })

  sectionEl.addEventListener('dragstart', (e) => {
    const srow = e.target.closest('.dsf-srow')
    if (srow && sectionEl.contains(srow)) {
      currentDrag = { id: srow.dataset.dsfSession, from: srow.dataset.dsfFolder }
      try { e.dataTransfer.setData('text/plain', currentDrag.id); e.dataTransfer.effectAllowed = 'move' } catch {}
      document.body.classList.add('dsf-dragging')
      return
    }
    const frow = e.target.closest('.dsf-frow')
    if (frow && sectionEl.contains(frow)) {
      currentDrag = { folder: frow.dataset.dsfFolder }
      try { e.dataTransfer.setData('text/plain', 'dsf-folder:' + currentDrag.folder) } catch {}
      document.body.classList.add('dsf-dragging')
      document.body.classList.add('dsf-dragging-folder')
    }
  })

  sectionEl.addEventListener('dragover', (e) => {
    if (!currentDrag) return
    const frow = e.target.closest('.dsf-frow')
    const srow = e.target.closest('.dsf-srow')
    const zone = e.target.closest('.dsf-ungroup-zone')
    const tzone = e.target.closest('.dsf-topzone')
    if (tzone && currentDrag.folder) {
      e.preventDefault(); e.dataTransfer.dropEffect = 'move'
      tzone.classList.add('dsf-drop')
      return
    }
    if (zone && currentDrag.id && currentDrag.from) {
      e.preventDefault(); e.dataTransfer.dropEffect = 'move'
      zone.classList.add('dsf-drop')
      return
    }
    if (srow && currentDrag.id) {
      e.preventDefault(); e.dataTransfer.dropEffect = 'move'
      const rect = srow.getBoundingClientRect()
      const before = (e.clientY - rect.top) < rect.height / 2
      srow.classList.toggle('dsf-drop-before', before)
      srow.classList.toggle('dsf-drop-after', !before)
      return
    }
    if (frow) {
      if (currentDrag.folder === frow.dataset.dsfFolder) return
      e.preventDefault(); e.dataTransfer.dropEffect = 'move'
      if (currentDrag.folder) {
        // 拖的是文件夹：上 1/3 = 排到前面，下 1/3 = 排到后面，中 1/3 = 嵌套进去
        const rect = frow.getBoundingClientRect()
        const rel = (e.clientY - rect.top) / Math.max(1, rect.height)
        frow.classList.toggle('dsf-drop-before', rel < 0.34)
        frow.classList.toggle('dsf-drop-after', rel > 0.66)
        frow.classList.toggle('dsf-drop', rel >= 0.34 && rel <= 0.66)
        // 只有中间区（嵌套）才悬停自动展开
        if (rel >= 0.34 && rel <= 0.66) {
          const fid = frow.dataset.dsfFolder
          const f = folderById(fid)
          if (f && f.collapsed && !expandTimer) {
            expandTimer = setTimeout(() => {
              expandTimer = 0
              const ff = folderById(fid)
              if (ff && ff.collapsed && currentDrag) apiOp({ type: 'folder.update', id: fid, patch: { collapsed: false } }).then(() => render(true))
            }, 700)
          }
        }
      } else {
        frow.classList.add('dsf-drop')
        // 拖的是会话：悬停自动展开
        const fid = frow.dataset.dsfFolder
        const f = folderById(fid)
        if (f && f.collapsed && !expandTimer) {
          expandTimer = setTimeout(() => {
            expandTimer = 0
            const ff = folderById(fid)
            if (ff && ff.collapsed && currentDrag) apiOp({ type: 'folder.update', id: fid, patch: { collapsed: false } }).then(() => render(true))
          }, 700)
        }
      }
    }
  })

  sectionEl.addEventListener('dragleave', (e) => {
    const el = e.target.closest('.dsf-frow, .dsf-srow, .dsf-ungroup-zone')
    if (el) el.classList.remove('dsf-drop', 'dsf-drop-before', 'dsf-drop-after')
    if (expandTimer) { clearTimeout(expandTimer); expandTimer = 0 }
  })

  sectionEl.addEventListener('drop', (e) => {
    if (!currentDrag) return
    const zone = e.target.closest('.dsf-ungroup-zone')
    const tzone = e.target.closest('.dsf-topzone')
    const srow = e.target.closest('.dsf-srow')
    const frow = e.target.closest('.dsf-frow')
    if (tzone && currentDrag.folder) {
      e.preventDefault()
      apiOp({ type: 'folder.update', id: currentDrag.folder, patch: { parentId: null } }).then((r) => {
        if (r.ok) toast('已移到顶层')
        else if (!r.conflict) toast('移动失败：' + (r.error || ''))
        render(true)
      })
    } else if (zone && currentDrag.id && currentDrag.from) {
      e.preventDefault()
      moveSessions([currentDrag.id], null)
    } else if (srow && currentDrag.id && srow.dataset.dsfSession !== currentDrag.id) {
      e.preventDefault()
      const rect = srow.getBoundingClientRect()
      const before = (e.clientY - rect.top) < rect.height / 2
      const fid = srow.dataset.dsfFolder
      let beforeId = null
      if (before) beforeId = srow.dataset.dsfSession
      else {
        // 放到该会话之后 → 找下一个可见会话作为 before
        const f = folderById(fid)
        if (f) {
          const vis = visibleSessionIds(f)
          const idx = vis.indexOf(srow.dataset.dsfSession)
          beforeId = vis[idx + 1] || null
        }
      }
      moveSessions([currentDrag.id], fid, beforeId)
    } else if (frow) {
      e.preventDefault()
      if (currentDrag.id) {
        moveSessions([currentDrag.id], frow.dataset.dsfFolder)
      } else if (currentDrag.folder && currentDrag.folder !== frow.dataset.dsfFolder) {
        // 上 1/3 = 排到目标前面；下 1/3 = 排到目标后面；中 1/3 = 嵌套进目标
        const rect = frow.getBoundingClientRect()
        const rel = (e.clientY - rect.top) / Math.max(1, rect.height)
        const mode = rel < 0.34 ? 'before' : rel > 0.66 ? 'after' : 'inside'
        moveFolderWithOrder(currentDrag.folder, frow.dataset.dsfFolder, mode)
      }
    }
    clearDropHints()
  })
}

/** 文件夹拖放落点：before=排到目标前面，after=排到目标后面，inside=嵌套进目标。父级变更 + 同级重排两步走。 */
async function moveFolderWithOrder(dragId, targetId, mode) {
  const drag = folderById(dragId)
  const target = folderById(targetId)
  if (!drag || !target || dragId === targetId) return
  if (isDescendantOf(targetId, dragId)) { toast('不能移到自己的子文件夹里'); render(true); return }
  const newPid = mode === 'inside' ? targetId : (target.parentId || null)
  // 1. 父级变了先改父级
  if ((drag.parentId || null) !== newPid) {
    const r = await apiOp({ type: 'folder.update', id: dragId, patch: { parentId: newPid } })
    if (!r.ok) { if (!r.conflict) toast('移动失败：' + (r.error || '')); render(true); return }
  }
  // 2. 同级重排（folder.reorder 要求 orderedIds 恰好覆盖该父级全部子文件夹）
  const sibs = childFolders(newPid).map((f) => f.id).filter((id) => id !== dragId)
  let idx = mode === 'inside' ? sibs.length : sibs.indexOf(targetId)
  if (idx < 0) idx = sibs.length
  if (mode === 'after') idx += 1
  sibs.splice(idx, 0, dragId)
  const r2 = await apiOp({ type: 'folder.reorder', parentId: newPid, orderedIds: sibs })
  if (r2.ok) toast(mode === 'inside' ? '已移入「' + target.name + '」' : '已调整顺序')
  else if (!r2.conflict) toast('排序失败：' + (r2.error || ''))
  // 嵌套进目标后自动展开目标，避免"移动完看不见"的困惑
  if (mode === 'inside' && r2.ok && target.collapsed) {
    await apiOp({ type: 'folder.update', id: targetId, patch: { collapsed: false } })
  }
  render(true)
}

/** 文件夹「移动到…」子菜单：同工作区内、除自己和子孙外的所有文件夹 */
function folderMovePickItems(fid) {
  const self = folderById(fid)
  const items = []
  if (!self) return items
  const wsId = folderWsId(self)
  const walk = (pid, depth) => {
    for (const f of childFolders(pid)) {
      if (f.id === fid || isDescendantOf(f.id, fid)) continue // 自己和子孙不能作为目标
      if (folderWsId(f) !== wsId) continue
      const label = '　'.repeat(depth) + (f.icon || '📁') + ' ' + f.name + (f.id === self.parentId ? '（当前所在）' : '')
      items.push({ label, disabled: f.id === self.parentId, action: () => moveFolderWithOrder(fid, f.id, 'inside') })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  if (items.length === 0) items.push({ label: '（没有可移动的文件夹）', disabled: true })
  return items
}

function clearDropHints() {
  document.querySelectorAll('.dsf-section .dsf-drop, .dsf-section .dsf-drop-before, .dsf-section .dsf-drop-after').forEach((el) => el.classList.remove('dsf-drop', 'dsf-drop-before', 'dsf-drop-after'))
  document.body.classList.remove('dsf-dragging')
  document.body.classList.remove('dsf-dragging-folder')
  if (expandTimer) { clearTimeout(expandTimer); expandTimer = 0 }
}

// ---------- 样式 ----------
const CSS_TEXT = `
.dsf-section{margin:1px 0 2px;padding:0 2px 0 6px;user-select:none}
.dsf-hidden{display:none!important}
.dsf-header{display:flex;align-items:center;gap:6px;padding:4px 10px 2px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary,#9a9aa3)}
.dsf-header-icon{font-size:12px}
.dsf-header-title{font-weight:600;letter-spacing:.04em}
.dsf-header-count{opacity:.7}
.dsf-header-actions{margin-left:auto;display:flex;gap:2px}
.dsf-icon-btn{border:none;background:transparent;color:inherit;cursor:pointer;border-radius:6px;width:20px;height:20px;line-height:1;font-size:13px;padding:0;display:inline-flex;align-items:center;justify-content:center}
.dsf-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15))}
.dsf-icon-btn.dsf-on{background:var(--dsw-alias-interactive-bg-hover,rgba(79,142,247,.25));color:var(--dsw-alias-label-primary,#eee)}
.dsf-row-menu{opacity:0;font-size:12px}
.dsf-row-new{opacity:0;font-size:13px;font-weight:600}
.dsf-frow:hover .dsf-row-menu,.dsf-srow:hover .dsf-row-menu,.dsf-frow:hover .dsf-row-new{opacity:.8}
.dsf-hint{padding:4px 10px 8px;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);display:flex;flex-direction:column;gap:2px}
.dsf-hint-sub{opacity:.65;font-size:11px}
.dsf-link-btn{border:none;background:none;color:var(--dsw-alias-label-link,#4f8ef7);cursor:pointer;padding:0;font-size:12px;text-align:left}
.dsf-link-btn:hover{text-decoration:underline}
.dsf-frow,.dsf-srow{box-sizing:border-box;display:flex;align-items:center;gap:6px;border-radius:8px;cursor:pointer;padding-right:8px;padding-left:calc(8px + var(--dsf-depth,0)*14px);color:var(--dsw-alias-label-primary,#e8e8ec);position:relative}
.dsf-frow{height:30px;font-size:13px;background:var(--dsf-tint,transparent)}
.dsf-srow{height:28px;font-size:13px;animation:dsf-row-in .15s ease}
@keyframes dsf-row-in{0%{opacity:0}}
.dsf-frow:hover{background:var(--dsf-tint-hover,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12)))}
.dsf-srow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsf-frow .dsf-title{font-weight:600}
.dsf-srow.dsf-current{background:var(--dsw-alias-interactive-bg-hover,rgba(79,142,247,.22))}
.dsf-arrow{width:30px;flex:none;text-align:center;color:CanvasText;opacity:.85;font-size:24px;font-weight:700;padding:4px 0;margin:-4px 0;cursor:pointer}
.dsf-dot{width:8px;height:8px;border-radius:50%;flex:none}
.dsf-dot-default{background:var(--dsw-alias-label-tertiary,#8a8f98)}
.dsf-ficon{flex:none;font-size:13px}
.dsf-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsf-count{flex:none;font-size:12px;font-weight:600;color:CanvasText;opacity:.6}
.dsf-status{width:7px;height:7px;border-radius:50%;flex:none;background:transparent}
.dsf-status.dsf-run{background:#4f8ef7;animation:dsf-pulse 1.2s ease-in-out infinite}
.dsf-status.dsf-done{background:#4caf7d}
@keyframes dsf-pulse{50%{opacity:.35}}
.dsf-empty{padding:2px 8px 4px calc(8px + var(--dsf-depth,0)*14px);font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}
.dsf-fbody{}
.dsf-guide::before{content:'';position:absolute;left:calc(1px + var(--dsf-depth,0)*14px);top:0;bottom:0;width:1px;background:var(--dsf-guide-color,rgba(127,127,127,.28));pointer-events:none}
.dsf-frow.dsf-drop{outline:1.5px dashed #4f8ef7;outline-offset:-2px;background:rgba(79,142,247,.12)}
.dsf-srow.dsf-drop-before{box-shadow:inset 0 2px 0 #4f8ef7}
.dsf-srow.dsf-drop-after{box-shadow:inset 0 -2px 0 #4f8ef7}
.dsf-ungroup-zone{display:none;margin:4px 6px 2px;padding:8px;border:1.5px dashed var(--dsw-alias-label-secondary,#81858c);border-radius:8px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b)}
body.dsf-dragging .dsf-section .dsf-ungroup-zone{display:block}
.dsf-ungroup-zone.dsf-drop{border-color:#e08a3c;color:#e08a3c;background:rgba(224,138,60,.1)}
.dsf-topzone{display:none;margin:2px 6px 4px;padding:8px;border:1.5px dashed var(--dsw-alias-label-secondary,#81858c);border-radius:8px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b)}
body.dsf-dragging-folder .dsf-section .dsf-topzone{display:block}
body.dsf-dragging-folder .dsf-section .dsf-ungroup-zone{display:none}
.dsf-topzone.dsf-drop{border-color:#4f8ef7;color:#4f8ef7;background:rgba(79,142,247,.1)}
.dsf-frow.dsf-drop-before{box-shadow:inset 0 3px 0 #4f8ef7}
.dsf-frow.dsf-drop-after{box-shadow:inset 0 -3px 0 #4f8ef7}
.dsf-check{display:none;width:14px;height:14px;flex:none;border:1.5px solid var(--dsw-alias-label-tertiary,#9a9aa3);border-radius:4px;margin-left:auto}
.dsf-check.dsf-show{display:inline-block}
body.dsf-selecting .dsf-section .dsf-check{display:inline-block}
.dsf-check.dsf-checked{background:#4f8ef7;border-color:#4f8ef7;box-shadow:inset 0 0 0 2px Canvas}
.dsf-selectbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 4px 6px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(79,142,247,.1));font-size:12px;color:var(--dsw-alias-label-primary,#e8e8ec)}
.dsf-select-count{font-weight:600}
.dsf-select,.dsf-input{box-sizing:border-box;background:Canvas;color:CanvasText;border:1px solid rgba(127,127,127,.3);border-radius:6px;padding:3px 6px;font-size:12px;max-width:140px}
.dsf-input{width:100%;max-width:none;padding:6px 8px;font-size:13px}
.dsf-input-error{border-color:#e05252}
.dsf-btn{border:1px solid rgba(127,127,127,.35);background:transparent;color:var(--dsw-alias-label-primary,#e8e8ec);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}
.dsf-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15))}
.dsf-btn-primary{background:#4f8ef7;border-color:#4f8ef7;color:#fff}
.dsf-btn-primary:hover{background:#3f7de6}
.dsf-btn-danger{background:#e05252;border-color:#e05252;color:#fff}
.dsf-btn-danger{border:1px solid #ec1313;color:#ec1313;background:transparent}
.dsf-btn-ghost{border-color:rgba(127,127,127,.35);color:var(--dsw-alias-label-primary,#0f1115)}
.dsf-menu{position:fixed;z-index:100001;min-width:172px;max-width:280px;max-height:70vh;overflow-y:auto;background:Canvas;color:CanvasText;border:1px solid rgba(127,127,127,.35);border-radius:10px;padding:4px;box-shadow:0 10px 32px rgba(0,0,0,.25);font-size:13px}
.dsf-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsf-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsf-menu-item.dsf-disabled{opacity:.45;cursor:default}
.dsf-menu-item.dsf-disabled:hover{background:none}
.dsf-menu-item.dsf-danger{color:#e0655f}
.dsf-menu-sep{height:1px;margin:4px 6px;background:rgba(127,127,127,.25)}
.dsf-menu-arrow{opacity:.6;font-size:11px}
.dsf-submenu{position:fixed;z-index:100002}
.dsf-overlay{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
.dsf-dialog{position:relative;width:340px;max-width:calc(100vw - 40px);background:Canvas;color:CanvasText;border:1px solid rgba(127,127,127,.35);border-radius:12px;padding:16px;box-shadow:0 16px 48px rgba(0,0,0,.3);display:flex;flex-direction:column;gap:6px;font-size:13px}
.dsf-dialog-close{position:absolute;top:8px;right:8px;width:26px;height:26px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font-size:15px;cursor:pointer;border-radius:6px;display:inline-flex;align-items:center;justify-content:center}
.dsf-dialog-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));color:var(--dsw-alias-label-primary,#0f1115)}
.dsf-dialog-title{font-size:15px;font-weight:600;margin-bottom:4px}
.dsf-dialog-text{color:var(--dsw-alias-label-secondary,#b9b9c0);line-height:1.6;margin-bottom:6px}
.dsf-field-label{font-size:12px;color:var(--dsw-alias-label-tertiary,#9a9aa3);margin-top:6px}
.dsf-select-full{max-width:none;width:100%}
.dsf-swatches{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsf-swatch{width:20px;height:20px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0}
.dsf-swatch.dsf-on{border-color:Canvas;box-shadow:0 0 0 2px #4f8ef7}
.dsf-swatch-none{background:linear-gradient(135deg,#666 45%,transparent 45%,transparent 55%,#666 55%)}
.dsf-color-input{width:28px;height:24px;border:none;background:none;padding:0;cursor:pointer}
.dsf-icons{display:flex;gap:4px;flex-wrap:wrap}
.dsf-icon-pick{width:28px;height:28px;border-radius:6px;border:1px solid transparent;background:transparent;cursor:pointer;font-size:15px;display:inline-flex;align-items:center;justify-content:center}
.dsf-icon-pick:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsf-icon-pick.dsf-on{border-color:#4f8ef7;background:rgba(79,142,247,.15)}
.dsf-dialog-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
.dsf-dialog-btns .dsf-btn{padding:5px 14px;font-size:13px}
.dsf-toast{position:fixed;left:16px;bottom:16px;z-index:100003;background:Canvas;color:CanvasText;border:1px solid rgba(127,127,127,.35);border-radius:8px;padding:8px 14px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.25);animation:dsf-row-in .15s ease}
`

function injectStyles() {
  let el = document.getElementById('dsf-styles')
  if (el) el.remove()
  el = h('style')
  el.id = 'dsf-styles'
  el.textContent = CSS_TEXT
  document.head.append(el)
  return el
}

// ---------- 主入口 ----------
function apply(ctx) {
  app = ctx
  dshCtx = ctx

  // 自愈：清掉可能粘住的拖拽状态（其他插件热重载 / React 重挂载时 dragend 可能丢失，
  // 导致「移到此处…」两个提示区常驻显示）
  currentDrag = null
  document.body.classList.remove('dsf-dragging', 'dsf-dragging-folder')

  const styleEl = injectStyles()
  ctx.effect(() => () => styleEl.remove(), '@dsh-external/dsh-session-folders: styles')

  pullServiceData()
  loadState().then((ok) => {
    if (!ok) toast('分组服务未就绪（host API 无响应）')
    syncAll(true)
  })

  // 订阅服务数据变化
  try {
    const off = ctx.sessions.list.subscribe(() => {
      pullServiceData()
      render(false)
      debounceSync()
    })
    ctx.effect(() => () => { try { off() } catch {} }, '@dsh-external/dsh-session-folders: sessions sub')
  } catch { console.warn('dsh-session-folders: ctx.sessions 不可用') }
  try {
    const off = ctx.workspaces.list.subscribe(() => {
      pullServiceData()
      render(false)
    })
    ctx.effect(() => () => { try { off() } catch {} }, '@dsh-external/dsh-session-folders: workspaces sub')
  } catch { console.warn('dsh-session-folders: ctx.workspaces 不可用') }

  // DOM 观察：React 重渲染后重挂区块 + 重跑隐藏/复选框
  const mo = new MutationObserver(() => debounceSync())
  mo.observe(document.body, { childList: true, subtree: true })
  ctx.effect(() => () => mo.disconnect(), '@dsh-external/dsh-session-folders: observer')

  // 原生行：右键菜单（capture，原生无 contextmenu 处理）——会话行 + 工作区标题行
  const onNativeContextMenu = (e) => {
    const row = e.target && e.target.closest ? e.target.closest('[role="treeitem"]') : null
    if (!row) return
    const tb = findTreeBody()
    if (!tb || !tb.contains(row)) return
    const id = sessionIdOfRow(row)
    if (id) {
      e.preventDefault()
      e.stopPropagation()
      openSessionMenu(e.clientX, e.clientY, id)
      return
    }
    const g = groupInfoOfRow(row)
    if (g) {
      e.preventDefault()
      e.stopPropagation()
      openWorkspaceMenu(e.clientX, e.clientY, g.wsId, g.label)
    }
  }
  document.addEventListener('contextmenu', onNativeContextMenu, true)
  ctx.effect(() => () => document.removeEventListener('contextmenu', onNativeContextMenu, true), '@dsh-external/dsh-session-folders: ctxmenu')

  // 原生行：批量选择模式下点击 = 勾选而非打开（⋯ 菜单按钮放行）
  const onNativeClick = (e) => {
    if (!selectMode) return
    const t = e.target instanceof Element ? e.target : null
    if (!t) return
    if (t.closest('button[aria-label^="会话"][aria-label$="的操作"]')) return // ⋯ 菜单照常可用
    const row = t.closest('[role="treeitem"]')
    if (!row) return
    const tb = findTreeBody()
    if (!tb || !tb.contains(row)) return
    const id = sessionIdOfRow(row)
    if (!id) return
    if (state.memberships[id] || !summaries[id] || summaries[id].blank) return
    e.preventDefault()
    e.stopPropagation()
    toggleSelected(id)
  }
  document.addEventListener('click', onNativeClick, true)
  ctx.effect(() => () => document.removeEventListener('click', onNativeClick, true), '@dsh-external/dsh-session-folders: click')

  // 顶部「新建会话」按钮：新对话默认落到「闲聊」文件夹（没有闲聊则保持原生行为）
  const onNewSessionClick = (e) => {
    const t = e.target instanceof Element ? e.target : null
    if (!t) return
    const btn = t.closest('button[aria-label="新建会话"][class$="_newSession"]')
    if (!btn) return
    const candidates = state.folders.filter((f) => f.name === '闲聊')
    if (candidates.length === 0) return
    let target = candidates[0]
    const wsCur = currentId ? sessionWs.get(currentId) : undefined
    if (candidates.length > 1 && wsCur !== undefined) target = candidates.find((c) => folderWsId(c) === wsCur) || target
    e.preventDefault()
    e.stopPropagation()
    newSessionInFolder(target.id)
  }
  document.addEventListener('click', onNewSessionClick, true)
  ctx.effect(() => () => document.removeEventListener('click', onNewSessionClick, true), '@dsh-external/dsh-session-folders: newsession')

  // 原生行：拖拽来源登记（原生行 draggable，payload 带 sessionId）
  const onDragStart = (e) => {
    if (e.target instanceof Node && e.target.closest && e.target.closest('.dsf-section')) return // 自有行已处理
    const row = e.target && e.target.closest ? e.target.closest('[role="treeitem"]') : null
    if (!row) return
    const tb = findTreeBody()
    if (!tb || !tb.contains(row)) return
    const id = sessionIdOfRow(row)
    if (!id) return
    // 原生行在分组视图下没有自己的 dragstart 数据——由我们兜底写入，否则 drop 不被允许
    try {
      if (e.dataTransfer) {
        if (!e.dataTransfer.getData('text/plain')) e.dataTransfer.setData('text/plain', id)
        e.dataTransfer.effectAllowed = 'move'
      }
    } catch { /* ignore */ }
    currentDrag = { id, from: state.memberships[id] || null }
    document.body.classList.add('dsf-dragging')
  }
  // 注意：不要监听 document 级 drop——capture 阶段会先清空 currentDrag，导致区块 drop 失效。
  // dragend 在 drop 之后触发，足以兜底清理。
  const onDragEnd = () => { currentDrag = null; clearDropHints() }
  document.addEventListener('dragstart', onDragStart, true)
  document.addEventListener('dragend', onDragEnd, true)
  ctx.effect(() => () => {
    document.removeEventListener('dragstart', onDragStart, true)
    document.removeEventListener('dragend', onDragEnd, true)
    document.body.classList.remove('dsf-dragging', 'dsf-dragging-folder')
    currentDrag = null
  }, '@dsh-external/dsh-session-folders: drag')

  // 原生 ⋯ 菜单：会话行注入「移动到分组… / 移出分组」；工作区行注入「新建文件夹」
  const onRowMenuBtn = (e) => {
    const t = e.target && e.target.closest ? e.target : null
    if (!t || !t.closest) { pendingRowMenu = null; return }
    const sBtn = t.closest('button[aria-label^="会话"][aria-label$="的操作"]')
    if (sBtn) {
      const row = sBtn.closest('[role="treeitem"]')
      const sid = row ? sessionIdOfRow(row) : null
      pendingRowMenu = sid ? { sid, at: Date.now(), rect: sBtn.getBoundingClientRect() } : null
      return
    }
    const wBtn = t.closest('button[aria-label^="工作区"][aria-label$="的操作"]')
    if (wBtn) {
      const row = wBtn.closest('[role="treeitem"]')
      const g = row ? groupInfoOfRow(row) : null
      pendingRowMenu = g ? { ws: { wsId: g.wsId, label: g.label }, at: Date.now(), rect: wBtn.getBoundingClientRect() } : null
      return
    }
    pendingRowMenu = null
  }
  document.addEventListener('click', onRowMenuBtn, true)
  ctx.effect(() => () => document.removeEventListener('click', onRowMenuBtn, true), '@dsh-external/dsh-session-folders: row-menu-btn')

  const menuMo = new MutationObserver(() => {
    if (!pendingRowMenu || Date.now() - pendingRowMenu.at > 2500) return
    document.querySelectorAll('div[role="menu"]:not([data-dsf-done])').forEach((m) => {
      if (m.querySelectorAll('button[role="menuitem"]').length === 0) return
      m.dataset.dsfDone = '1'
      injectNativeMenuItems(m)
    })
  })
  menuMo.observe(document.body, { childList: true, subtree: true })
  ctx.effect(() => () => menuMo.disconnect(), '@dsh-external/dsh-session-folders: menu-observer')

  // 菜单/弹窗关闭（子菜单挂在 body 上，点击它不算"外部"）
  const inMenu = (t) => t instanceof Node && ((menuEl && menuEl.contains(t)) || (t instanceof Element && !!t.closest('.dsf-submenu')))
  const onPointerDown = (e) => {
    if (menuEl && !inMenu(e.target)) closeMenu()
  }
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (dialogEl) closeDialog()
      else if (menuEl) closeMenu()
      else if (selectMode) setSelectMode(false)
    }
  }
  const onWheel = (e) => {
    if (menuEl && !inMenu(e.target)) closeMenu()
  }
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('wheel', onWheel, true)
  ctx.effect(() => () => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('wheel', onWheel, true)
  }, '@dsh-external/dsh-session-folders: global-dismiss')

  // 侧栏底部「批量选择」按钮已移除——批量选择模式仍可从会话右键菜单 / ⋯ 菜单进入

  // 调试句柄（验证用）
  window.__dshSessionFolders = {
    get state() { return state },
    get sections() { return [...sections.entries()].map(([k, v]) => ({ key: k, wsId: v.wsId })) },
    get sessionWs() { return { size: sessionWs.size, sample: [...sessionWs.entries()].slice(0, 3) } },
    reload: () => loadState(1).then(() => syncAll(true)),
    render: () => syncAll(true),
  }
}

exports.apply = apply
