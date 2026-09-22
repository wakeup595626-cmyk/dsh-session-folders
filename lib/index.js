/**
 * @dsh-external/dsh-session-folders — host 半。
 *
 * 会话分组（文件夹）插件的 host 侧：folders 状态持久化 + 只读/变更 REST API。
 * 数据文件默认 ~/.dsh/profiles/web/session-folders.json（可用 config.storagePath 覆盖）。
 *
 * 数据结构：
 *   state = {
 *     version: number,                       // 单调递增，客户端乐观并发控制用
 *     folders: [{ id, name, color, icon, parentId, order, collapsed, sessionOrder[], createdAt, updatedAt }],
 *     memberships: { [sessionId]: folderId } // 一个会话同一时间只属于一个文件夹
 *   }
 *
 * API（prefix: /@dsh-external/dsh-session-folders/api）：
 *   GET  /state -> { version, folders, memberships }
 *   GET  /health -> { ok: true }
 *   POST /op    { version, op } -> 200 { version, folders, memberships } | 400 { error } | 409 { version, ...state }
 *
 * op 类型：folder.create / folder.update / folder.delete / folder.reorder / sessions.move
 * 纯 Node 内置依赖（fs/path/os），不 import 任何 dsh 包，免构建拷贝即可运行。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export const name = '@dsh-external/dsh-session-folders'
export const inject = ['webServer']

const API_PREFIX = '/@dsh-external/dsh-session-folders/api'
const MAX_NAME = 60
const MAX_ICON = 8
const MAX_FOLDERS = 200
const MAX_SESSIONS_PER_FOLDER = 500
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

function defaultState() {
  return { version: 0, folders: [], memberships: {} }
}

function isId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\\/:*?"<>|\x00-\x1f]/.test(v)
}

function cleanName(v) {
  if (typeof v !== 'string') return null
  const s = v.trim().slice(0, MAX_NAME)
  return s.length > 0 ? s : null
}

function cleanColor(v) {
  if (v === '' || v === null || v === undefined) return ''
  if (typeof v === 'string' && COLOR_RE.test(v)) return v.toLowerCase()
  return null // null = 非法
}

function cleanIcon(v) {
  if (v === '' || v === null || v === undefined) return ''
  if (typeof v === 'string' && [...v].length <= 4 && v.length <= MAX_ICON) return v
  return null
}

/** workspaceId 清洗：null（未分组区）或 ≤128 字符串。 */
function cleanWorkspaceId(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string' || v.length > 128) return undefined // 非法
  return v
}

function normalizeFolder(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = isId(raw.id) ? raw.id : null
  const name = cleanName(raw.name)
  if (!id || !name) return null
  const color = cleanColor(raw.color)
  const icon = cleanIcon(raw.icon)
  if (color === null || icon === null) return null
  const workspaceId = cleanWorkspaceId(raw.workspaceId)
  if (workspaceId === undefined) return null
  return {
    id,
    name,
    color: color || '',
    icon: icon || '',
    workspaceId,
    parentId: isId(raw.parentId) ? raw.parentId : null,
    order: Number.isFinite(raw.order) ? raw.order : 0,
    collapsed: raw.collapsed === true,
    sessionOrder: Array.isArray(raw.sessionOrder) ? raw.sessionOrder.filter(isId).slice(0, MAX_SESSIONS_PER_FOLDER) : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function loadState(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const state = defaultState()
    if (Array.isArray(raw.folders)) {
      for (const f of raw.folders) {
        const nf = normalizeFolder(f)
        if (nf && !state.folders.some((x) => x.id === nf.id)) state.folders.push(nf)
      }
    }
    const ids = new Set(state.folders.map((f) => f.id))
    // 修父指针：父不存在则提到顶层
    for (const f of state.folders) if (f.parentId && !ids.has(f.parentId)) f.parentId = null
    if (raw.memberships && typeof raw.memberships === 'object') {
      for (const [sid, fid] of Object.entries(raw.memberships)) {
        if (isId(sid) && ids.has(fid)) state.memberships[sid] = fid
      }
    }
    state.version = Number.isFinite(raw.version) ? raw.version : 0
    return state
  } catch {
    return defaultState()
  }
}

function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, file)
}

/** folderId 是否为 ancestorId 的后代（含自身）。 */
function isDescendant(folders, folderId, ancestorId) {
  let cur = folderId
  const seen = new Set()
  while (cur && !seen.has(cur)) {
    if (cur === ancestorId) return true
    seen.add(cur)
    cur = folders.find((f) => f.id === cur)?.parentId ?? null
  }
  return false
}

/**
 * 应用一个 op 到 state 副本。
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function applyOp(state, op) {
  if (!op || typeof op !== 'object' || typeof op.type !== 'string') return { ok: false, error: 'op.type 缺失' }
  const now = new Date().toISOString()

  switch (op.type) {
    case 'folder.create': {
      const f = normalizeFolder(op.folder)
      if (!f) return { ok: false, error: '文件夹参数非法（需要 id/name，color 需为 #rrggbb）' }
      if (state.folders.length >= MAX_FOLDERS) return { ok: false, error: '文件夹数量超限' }
      if (state.folders.some((x) => x.id === f.id)) return { ok: false, error: '文件夹 id 冲突' }
      if (f.parentId && !state.folders.some((x) => x.id === f.parentId)) return { ok: false, error: '父文件夹不存在' }
      f.createdAt = now
      f.updatedAt = now
      state.folders.push(f)
      return { ok: true }
    }
    case 'folder.update': {
      const f = state.folders.find((x) => x.id === op.id)
      if (!f) return { ok: false, error: '文件夹不存在' }
      const p = op.patch && typeof op.patch === 'object' ? op.patch : {}
      if (p.name !== undefined) {
        const n = cleanName(p.name)
        if (!n) return { ok: false, error: '名称不能为空' }
        f.name = n
      }
      if (p.color !== undefined) {
        const c = cleanColor(p.color)
        if (c === null) return { ok: false, error: '颜色需为 #rrggbb' }
        f.color = c
      }
      if (p.icon !== undefined) {
        const i = cleanIcon(p.icon)
        if (i === null) return { ok: false, error: '图标非法' }
        f.icon = i
      }
      if (p.collapsed !== undefined) f.collapsed = p.collapsed === true
      if (p.workspaceId !== undefined) {
        const w = cleanWorkspaceId(p.workspaceId)
        if (w === undefined) return { ok: false, error: 'workspaceId 非法' }
        f.workspaceId = w
      }
      if (p.parentId !== undefined) {
        const pid = p.parentId === null ? null : isId(p.parentId) ? p.parentId : undefined
        if (pid === undefined) return { ok: false, error: 'parentId 非法' }
        if (pid && !state.folders.some((x) => x.id === pid)) return { ok: false, error: '父文件夹不存在' }
        if (pid && isDescendant(state.folders, pid, f.id)) return { ok: false, error: '不能把文件夹移动到自己的子文件夹里' }
        f.parentId = pid
      }
      f.updatedAt = now
      return { ok: true }
    }
    case 'folder.delete': {
      const idx = state.folders.findIndex((x) => x.id === op.id)
      if (idx === -1) return { ok: false, error: '文件夹不存在' }
      const target = state.folders[idx]
      // 组内会话回到未分组
      for (const sid of Object.keys(state.memberships)) {
        if (state.memberships[sid] === target.id) delete state.memberships[sid]
      }
      // 子文件夹上移一级
      for (const f of state.folders) if (f.parentId === target.id) f.parentId = target.parentId
      state.folders.splice(idx, 1)
      return { ok: true }
    }
    case 'folder.reorder': {
      // 在同一父级下重排：orderedIds 覆盖该父级全部子文件夹的顺序
      const pid = op.parentId === null ? null : op.parentId
      const siblings = state.folders.filter((f) => f.parentId === pid)
      const want = Array.isArray(op.orderedIds) ? op.orderedIds.filter(isId) : []
      const sibIds = new Set(siblings.map((f) => f.id))
      if (want.length !== siblings.length || !want.every((id) => sibIds.has(id))) {
        return { ok: false, error: 'orderedIds 必须恰好覆盖同级文件夹' }
      }
      want.forEach((id, i) => {
        const f = state.folders.find((x) => x.id === id)
        if (f) f.order = i
      })
      return { ok: true }
    }
    case 'sessions.move': {
      const ids = Array.isArray(op.sessionIds) ? op.sessionIds.filter(isId) : []
      if (ids.length === 0) return { ok: false, error: 'sessionIds 为空' }
      const fid = op.folderId === null ? null : op.folderId
      if (fid !== null && !state.folders.some((x) => x.id === fid)) return { ok: false, error: '目标文件夹不存在' }
      if (fid !== null && !isId(fid)) return { ok: false, error: 'folderId 非法' }
      // 先从所有文件夹的 sessionOrder 与 memberships 中移除
      for (const f of state.folders) {
        f.sessionOrder = f.sessionOrder.filter((sid) => !ids.includes(sid))
      }
      for (const sid of ids) delete state.memberships[sid]
      // 再加入目标
      if (fid !== null) {
        const target = state.folders.find((x) => x.id === fid)
        const before = isId(op.beforeId) ? op.beforeId : null
        let arr = target.sessionOrder
        for (const sid of ids) {
          state.memberships[sid] = fid
          if (arr.length >= MAX_SESSIONS_PER_FOLDER) return { ok: false, error: '文件夹内会话数量超限' }
          if (before && arr.includes(before)) {
            arr.splice(arr.indexOf(before), 0, sid)
          } else {
            arr.push(sid)
          }
        }
        target.updatedAt = now
      }
      return { ok: true }
    }
    default:
      return { ok: false, error: '未知 op: ' + op.type }
  }
}

function sendJson(res, code, obj) {
  const text = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function apply(ctx, config) {
  const file =
    (config && typeof config.storagePath === 'string' && config.storagePath) ||
    path.join(os.homedir(), '.dsh', 'profiles', 'web', 'session-folders.json')

  let state = loadState(file)

  const persist = () => {
    try {
      saveState(file, state)
    } catch (e) {
      ctx.logger?.warn?.('dsh-session-folders: 持久化失败: %s', String(e))
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const method = String(req.method || 'GET').toUpperCase()
        const url = String(req.url || '').split('?')[0]
        if (method === 'GET' && /\/health\/?$/.test(url)) {
          sendJson(res, 200, { ok: true, file, folders: state.folders.length })
          return
        }
        if (method === 'GET' && /\/status\/?$/.test(url)) {
          // 浏览器可读的 HTML 状态页（也用于交付烟测）
          const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
          const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-session-folders</title>'
            + '<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#24292f}h1{font-size:20px}.ok{color:#1a7f37;font-weight:600}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px}dt{color:#57606a}dd{margin:0}</style>'
            + '</head><body><h1>🗂 @dsh-external/dsh-session-folders</h1>'
            + '<p class="ok">● 服务正常</p><dl>'
            + '<dt>folders</dt><dd>' + state.folders.length + '</dd>'
            + '<dt>memberships</dt><dd>' + Object.keys(state.memberships).length + '</dd>'
            + '<dt>version</dt><dd>' + state.version + '</dd>'
            + '<dt>storage</dt><dd>' + esc(file) + '</dd>'
            + '</dl></body></html>'
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(html)
          return
        }
        if (method === 'GET' && /\/state\/?$/.test(url)) {
          sendJson(res, 200, state)
          return
        }
        if (method === 'POST' && /\/op\/?$/.test(url)) {
          const body = await readBody(req)
          let payload
          try {
            payload = JSON.parse(body)
          } catch {
            sendJson(res, 400, { error: '请求体不是合法 JSON' })
            return
          }
          if (typeof payload.version !== 'number') {
            sendJson(res, 400, { error: '缺少 version' })
            return
          }
          if (payload.version !== state.version) {
            sendJson(res, 409, state) // 客户端拿最新 state 重放/放弃
            return
          }
          const result = applyOp(state, payload.op)
          if (!result.ok) {
            sendJson(res, 400, { error: result.error, version: state.version })
            return
          }
          state.version += 1
          persist()
          sendJson(res, 200, state)
          return
        }
        sendJson(res, 404, { error: 'not found' })
      } catch (e) {
        sendJson(res, 500, { error: String(e) })
      }
    },
  }), '@dsh-external/dsh-session-folders: api')

  ctx.logger?.info?.('dsh-session-folders: 数据文件 %s（%d 个文件夹）', file, state.folders.length)
}
