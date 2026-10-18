/**
 * dsh-shutdown-idle — Host 半：所有会话都结束后自动执行关机等动作。
 *
 * 每秒采样进程内全部 Agent 会话（ctx.get('agents').list()）：当没有任何会话处于
 * status === 'running'，且（按配置）没有后台作业在跑，并保持空闲 settleSeconds 秒后，
 * 进入 countdownSeconds 秒倒计时；倒计时结束执行配置的动作（默认 Windows 关机）。
 * 倒计时期间任何会话重新开始运行、或用户点「取消」，本次动作立即撤销。
 *
 * 会话判据与 dshmarket 的更新守卫一致（只有 status === 'running' 才算会话在进行）；
 * 拿不到 agents 服务时按「不空闲」处理，宁可不执行。
 *
 * 配置：patch 行 config 为初始值，界面保存写入 <DSH_HOME>/dsh-shutdown-idle/settings.json
 * 并优先生效。开关自身不持久化：宿主重启后一律为「关闭」，避免开机即误关机。
 *
 * 同源接口：
 *   GET  /dsh-shutdown/api/state   开关、阶段、倒计时、运行中会话
 *   POST /dsh-shutdown/api/config  改开关/动作/时长
 *   POST /dsh-shutdown/api/cancel  取消倒计时并关闭开关
 *   GET  /dsh-shutdown             客户端半不可用时的兜底页面
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-shutdown-idle'
export const inject = ['timer']

/** 路由前缀；客户端半按同一路径取数。 */
const UI_PATH = '/dsh-shutdown'
/** 采样心跳：每秒一次，采样本身是进程内数组读取，开销可以忽略。 */
const TICK_MS = 1000
/** 配置请求体上限，超过即拒绝。 */
const MAX_BODY_BYTES = 16 * 1024
/** 冷启动时 webServer 尚未挂载 / 上一代 fiber 未卸载完，注册重试的间隔与次数。 */
const ROUTE_RETRY_MS = 200
const ROUTE_RETRY_LIMIT = 50

const HOME_DIR = process.env['DSH_HOME'] || join(homedir(), '.dsh')
const DATA_DIR = join(HOME_DIR, 'dsh-shutdown-idle')
const SETTINGS_FILE = join(DATA_DIR, 'settings.json')

/**
 * 可执行动作。`command` 为 null 表示只记录不执行（用于先验证判定链路，再放开真关机）。
 */
const ACTIONS = {
  shutdown: { label: '关机', hint: 'shutdown /s /t 0', command: ['shutdown', ['/s', '/t', '0']] },
  restart: { label: '重启', hint: 'shutdown /r /t 0', command: ['shutdown', ['/r', '/t', '0']] },
  hibernate: { label: '休眠', hint: 'shutdown /h', command: ['shutdown', ['/h']] },
  sleep: { label: '睡眠', hint: 'rundll32 powrprof.dll,SetSuspendState 0,1,0（系统禁用休眠时才是睡眠）', command: ['rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']] },
  lock: { label: '锁定屏幕', hint: 'rundll32 user32.dll,LockWorkStation', command: ['rundll32.exe', ['user32.dll,LockWorkStation']] },
  logoff: { label: '注销', hint: 'shutdown /l', command: ['shutdown', ['/l']] },
  none: { label: '仅记录（不执行）', hint: '不执行任何命令，只在日志与界面里记录这次本应执行的动作', command: null },
}

/** 初始值；patch 行 config 与界面保存的 settings.json 都按同一套字段归一化。 */
const DEFAULTS = {
  action: 'shutdown',
  settleSeconds: 20,
  countdownSeconds: 60,
  requireActivity: true,
  considerJobs: true,
}

const PHASE_LABEL = {
  off: '未开启',
  waiting: '等待会话开始',
  busy: '会话进行中',
  unknown: '无法确认会话状态',
  settle: '空闲确认中',
  countdown: '倒计时中',
  fired: '已执行',
}

/**
 * 归一化一份设置：给出合法值，并把被拒绝的字段记进 problems（调用方决定是报错还是告警）。
 * @param raw - 待读取的设置对象，缺省字段沿用 base。
 * @param base - 缺省来源。
 * @returns 归一化后的设置与问题描述。
 */
function normalizeSettings(raw, base) {
  const problems = []
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const out = { ...base }
  if (source.action !== undefined) {
    if (Object.hasOwn(ACTIONS, source.action)) out.action = String(source.action)
    else problems.push(`action 必须是 ${Object.keys(ACTIONS).join('/')} 之一，收到 ${JSON.stringify(source.action)}`)
  }
  for (const [field, min, max] of [['settleSeconds', 0, 3600], ['countdownSeconds', 0, 3600]]) {
    const value = source[field]
    if (value === undefined) continue
    const number = Number(value)
    if (Number.isInteger(number) && number >= min && number <= max) out[field] = number
    else problems.push(`${field} 必须是 ${min}~${max} 的整数，收到 ${JSON.stringify(value)}`)
  }
  for (const field of ['requireActivity', 'considerJobs']) {
    const value = source[field]
    if (value === undefined) continue
    if (typeof value === 'boolean') out[field] = value
    else problems.push(`${field} 必须是布尔值，收到 ${JSON.stringify(value)}`)
  }
  return { settings: out, problems }
}

/** 读回界面保存的设置；文件不存在或损坏时返回 undefined（沿用 patch 初始值）。 */
function loadSettings() {
  try {
    const text = readFileSync(SETTINGS_FILE, 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return undefined
    return undefined
  }
}

/** 原子落盘界面保存的设置（同目录临时文件 + rename），失败抛出由调用方回报。 */
function saveSettings(settings) {
  mkdirSync(DATA_DIR, { recursive: true })
  const temporary = `${SETTINGS_FILE}.tmp`
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  renameSync(temporary, SETTINGS_FILE)
}

/** 读取 JSON 请求体；超限或非法 JSON 抛错。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${String((error && error.message) || error)}`))
      }
    })
    req.on('error', (error) => { reject(error) })
  })
}

/** 统一 JSON 响应：只设 content-type，不钉 content-length（gzip 会改写 body 长度）。 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/** 兜底页面的 HTML：客户端半没加载出来时，开关仍然可用。 */
function renderPage() {
  const options = Object.entries(ACTIONS)
    .map(([value, spec]) => `<option value="${value}">${spec.label}</option>`)
    .join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>会话结束后关机</title>
<style>
body{margin:0;padding:24px;background:#0e1116;color:#e6e6e6;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif}
h1{font-size:17px;margin:0 0 4px}p.sub{opacity:.65;margin:0 0 14px;font-size:12px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0}
button{font:inherit;padding:5px 14px;border-radius:6px;border:1px solid #3a4250;background:#1b2029;color:inherit;cursor:pointer}
button.primary{background:#2f6feb;border-color:#2f6feb;color:#fff;font-weight:600}
input,select{font:inherit;padding:4px 8px;border-radius:6px;border:1px solid #3a4250;background:#161b22;color:inherit}
#status{margin:12px 0;padding:10px 12px;border-radius:8px;background:#161b22;white-space:pre-wrap;font-size:13px}
.hint{opacity:.6;font-size:12px}
.ok{color:#57ab5a}.err{color:#e0605f}.warn{color:#d9a441}
</style></head><body>
<h1>会话结束后关机</h1>
<p class="sub">所有会话（Agent 回合）结束并持续空闲后，执行所选动作。倒计时内可随时取消。</p>
<div id="status">加载中…</div>
<div class="row"><button id="toggle" class="primary">开启</button><button id="cancel">取消倒计时并关闭</button></div>
<div class="row">动作 <select id="action">${options}</select>
空闲确认 <input id="settle" type="number" min="0" max="3600" style="width:80px"> 秒
倒计时 <input id="countdown" type="number" min="0" max="3600" style="width:80px"> 秒
<label><input id="requireActivity" type="checkbox"> 必须观察到会话运行过</label>
<label><input id="considerJobs" type="checkbox"> 后台作业也算占用</label>
<button id="save">保存</button></div>
<div id="message" class="hint"></div>
<div class="hint" id="running"></div>
<script>
var state = null;
function el(id){return document.getElementById(id)}
function post(path, body){
  return fetch(path, {method:'POST', credentials:'same-origin', cache:'no-store',
    headers:{'content-type':'application/json'}, body: JSON.stringify(body||{})})
    .then(function(r){return r.text().then(function(t){var d=null;try{d=JSON.parse(t)}catch(e){d=null}
      if(d===null){throw new Error('HTTP '+r.status+' '+(t||'空响应'))}return d})})
}
function render(s){
  state = s;
  var lines = ['状态：'+(s.phaseLabel||s.phase)+(s.enabled?'（已开启）':'（未开启）'),
    '动作：'+(s.actionLabel||s.action), '空闲确认：'+s.settleSeconds+' 秒 ｜ 倒计时：'+s.countdownSeconds+' 秒',
    '运行中会话：'+(s.known?(s.running.length?s.running.join(', '):'无'):'无法确认')+' ｜ 运行中后台作业：'+s.jobs];
  if(s.phase==='countdown'||s.phase==='settle'){lines.push('将在 '+Math.round((s.remainingMs||0)/1000)+' 秒后执行'+(s.remainingMs>s.countdownSeconds*1000?'（含空闲确认）':''))}
  if(s.lastExecution){lines.push('上次执行：'+new Date(s.lastExecution.at).toLocaleString()+' · '+(s.lastExecution.ok?'成功':'失败')+' · '+s.lastExecution.detail)}
  if(s.error){lines.push('错误：'+s.error)}
  el('status').textContent = lines.join('\\n');
  el('toggle').textContent = s.enabled ? '关闭' : '开启';
  el('toggle').className = s.enabled ? '' : 'primary';
  if(document.activeElement !== el('action')) el('action').value = s.action;
  if(document.activeElement !== el('settle')) el('settle').value = s.settleSeconds;
  if(document.activeElement !== el('countdown')) el('countdown').value = s.countdownSeconds;
  el('requireActivity').checked = !!s.requireActivity;
  el('considerJobs').checked = !!s.considerJobs;
  el('running').textContent = '配置文件：'+s.settingsPath+'（开关状态不跨宿主重启保持）';
}
function poll(){fetch('/dsh-shutdown/api/state',{credentials:'same-origin',cache:'no-store'})
  .then(function(r){return r.json()}).then(render)
  .catch(function(e){el('status').textContent='宿主接口异常：'+e})}
function report(res, okText){el('message').textContent = res && res.ok ? (okText||'已保存') : ('失败：'+((res&&res.error)||'未知错误'))}
el('toggle').onclick = function(){post('/dsh-shutdown/api/config',{enabled:!state.enabled}).then(function(r){report(r);poll()})}
el('cancel').onclick = function(){post('/dsh-shutdown/api/cancel',{}).then(function(r){report(r,'已取消');poll()})}
el('save').onclick = function(){post('/dsh-shutdown/api/config',{action:el('action').value,
  settleSeconds:Number(el('settle').value), countdownSeconds:Number(el('countdown').value),
  requireActivity:el('requireActivity').checked, considerJobs:el('considerJobs').checked}).then(function(r){report(r);poll()})}
poll(); setInterval(poll, 1000);
</script></body></html>`
}

/**
 * 挂载插件：读取配置、起心跳、注册 HTTP 路由。
 * @param ctx - 插件上下文。
 * @param config - patch 行 config（初始设置）。
 */
export function apply(ctx, config = {}) {
  const initial = normalizeSettings(config, DEFAULTS)
  if (initial.problems.length > 0) {
    ctx.logger.warn(`dsh-shutdown-idle: patch 配置被拒绝的字段 → ${initial.problems.join('；')}`)
  }
  let settings = initial.settings
  const saved = loadSettings()
  if (saved !== undefined) {
    const merged = normalizeSettings(saved, settings)
    if (merged.problems.length > 0) {
      ctx.logger.warn(`dsh-shutdown-idle: ${SETTINGS_FILE} 被拒绝的字段 → ${merged.problems.join('；')}`)
    }
    settings = merged.settings
  }
  if (process.platform !== 'win32') {
    ctx.logger.warn(`dsh-shutdown-idle: 当前平台是 ${process.platform}，除「仅记录」外的动作不可用；请把 action 设为 none`)
  }

  let disposed = false
  let routeDisposer = null
  let routeRetries = 0
  let enabled = false
  let phase = 'off'
  let sawActivity = false
  let idleSince = 0
  let lastExecution = null
  let lastError = ''

  /** 某个 Agent 的会话 id；拿不到时返回 undefined。 */
  const sessionIdOf = (agent) => {
    const session = agent === null || typeof agent !== 'object' ? undefined : agent.session
    if (session !== null && typeof session === 'object' && typeof session.id === 'string') return session.id
    return undefined
  }

  /**
   * 采样当前占用：运行中的会话与（可选）后台作业。
   * known 为 false 表示拿不到 agents 服务或结构异常，调用方按「不空闲」处理。
   */
  const sample = () => {
    let agents
    try {
      agents = ctx.get('agents')
    } catch (error) {
      ctx.logger.warn(`dsh-shutdown-idle: 读取 agents 服务失败 → ${String((error && error.message) || error)}`)
      agents = undefined
    }
    let list = null
    try {
      list = agents !== undefined && agents !== null && typeof agents.list === 'function' ? agents.list() : null
    } catch (error) {
      ctx.logger.warn(`dsh-shutdown-idle: agents.list() 失败 → ${String((error && error.message) || error)}`)
      list = null
    }
    if (!Array.isArray(list)) return { known: false, running: [], jobs: 0 }
    const running = []
    const owners = []
    for (const agent of list) {
      const id = sessionIdOf(agent)
      if (id !== undefined) owners.push(id)
      if (agent !== null && typeof agent === 'object' && agent.status === 'running') running.push(id === undefined ? '(未知会话)' : id)
    }
    return { known: true, running, jobs: countRunningJobs(owners) }
  }

  /** 运行中的后台作业数：无主作业 + 每个存活会话名下的作业；拿不到 jobs 服务时记 0。 */
  const countRunningJobs = (owners) => {
    if (!settings.considerJobs) return 0
    let jobs
    try {
      jobs = ctx.get('jobs')
    } catch (error) {
      ctx.logger.warn(`dsh-shutdown-idle: 读取 jobs 服务失败 → ${String((error && error.message) || error)}`)
      return 0
    }
    if (jobs === undefined || jobs === null || typeof jobs.list !== 'function') return 0
    const count = (caller) => {
      try {
        const listed = caller === undefined ? jobs.list() : jobs.list(caller)
        return Array.isArray(listed) ? listed.filter((job) => job !== null && typeof job === 'object' && job.status === 'running').length : 0
      } catch (error) {
        ctx.logger.warn(`dsh-shutdown-idle: 作业列表读取失败 → ${String((error && error.message) || error)}`)
        return 0
      }
    }
    let total = count(undefined)
    for (const owner of owners) total += count(owner)
    return total
  }

  /** 空闲判定用的忙闲计数：>0 忙，0 空闲，-1 无法确认。 */
  const busyCount = () => {
    const sampled = sample()
    if (!sampled.known) return -1
    return sampled.running.length + sampled.jobs
  }

  /** 本次倒计时的剩余时间（毫秒）：已进入空闲且（满足活动要求）时才有意义。 */
  const remainingMs = (sampled) => {
    if (!enabled || idleSince === 0 || !sampled.known || sampled.running.length + sampled.jobs !== 0) return 0
    if (!sawActivity && settings.requireActivity) return 0
    const fireAt = idleSince + (settings.settleSeconds + settings.countdownSeconds) * 1000
    return Math.max(0, fireAt - Date.now())
  }

  /** 当前动作；非 Windows 平台上除 none 外一律降级为 none 并说明。 */
  const effectiveAction = () => {
    const key = Object.hasOwn(ACTIONS, settings.action) ? settings.action : 'none'
    if (process.platform !== 'win32' && key !== 'none') {
      return { key: 'none', label: `${ACTIONS[key].label}（当前平台不可用，未执行）`, hint: '非 Windows 平台不支持该动作', command: null }
    }
    return { key, ...ACTIONS[key] }
  }

  /** 执行动作：先按最新采样再确认一次空闲，然后派发命令（或只记录）。执行后一律关闭开关。 */
  const fire = () => {
    const busy = busyCount()
    if (busy !== 0) {
      idleSince = 0
      phase = busy > 0 ? 'busy' : 'unknown'
      return
    }
    enabled = false
    const spec = effectiveAction()
    const at = Date.now()
    if (spec.command === null) {
      lastExecution = { at, action: spec.key, ok: true, detail: `仅记录：${spec.hint}` }
      phase = 'fired'
      ctx.logger.info(`dsh-shutdown-idle: 会话已全部结束，动作「${spec.label}」按配置未实际执行`)
      return
    }
    try {
      const child = spawn(spec.command[0], spec.command[1], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', (error) => {
        const detail = `派发失败：${String((error && error.message) || error)}`
        lastExecution = { at, action: spec.key, ok: false, detail }
        lastError = detail
        ctx.logger.error(`dsh-shutdown-idle: ${detail}`)
      })
      child.unref()
      lastExecution = { at, action: spec.key, ok: true, detail: `已派发：${spec.hint}` }
      phase = 'fired'
      ctx.logger.warn(`dsh-shutdown-idle: 会话已全部结束，执行「${spec.label}」→ ${spec.command[0]} ${spec.command[1].join(' ')}`)
    } catch (error) {
      const detail = `派发失败：${String((error && error.message) || error)}`
      lastExecution = { at, action: spec.key, ok: false, detail }
      lastError = detail
      phase = 'fired'
      ctx.logger.error(`dsh-shutdown-idle: ${detail}`)
    }
  }

  /** 心跳：推进状态机，满足条件时执行动作。 */
  const tick = () => {
    if (disposed || !enabled) {
      if (!enabled && phase !== 'fired') phase = 'off'
      idleSince = 0
      return
    }
    const sampled = sample()
    const busy = sampled.known ? sampled.running.length + sampled.jobs : -1
    if (busy !== 0) {
      if (busy > 0) sawActivity = true
      phase = busy > 0 ? 'busy' : 'unknown'
      idleSince = 0
      return
    }
    if (!sawActivity && settings.requireActivity) {
      phase = 'waiting'
      idleSince = 0
      return
    }
    if (idleSince === 0) idleSince = Date.now()
    if (remainingMs(sampled) <= 0) {
      fire()
      return
    }
    phase = Date.now() < idleSince + settings.settleSeconds * 1000 ? 'settle' : 'countdown'
  }

  /** 对外状态：界面与兜底页面共用。 */
  const publicState = () => {
    const sampled = sample()
    const spec = effectiveAction()
    return {
      ok: true,
      enabled,
      phase,
      phaseLabel: PHASE_LABEL[phase] || phase,
      action: settings.action,
      actionLabel: spec.label,
      actionHint: spec.hint,
      settleSeconds: settings.settleSeconds,
      countdownSeconds: settings.countdownSeconds,
      requireActivity: settings.requireActivity,
      considerJobs: settings.considerJobs,
      remainingMs: remainingMs(sampled),
      running: sampled.running,
      known: sampled.known,
      jobs: sampled.jobs,
      sawActivity,
      lastExecution,
      error: lastError,
      settingsPath: SETTINGS_FILE,
      platform: process.platform,
      actions: Object.entries(ACTIONS).map(([value, entry]) => ({ value, label: entry.label, hint: entry.hint })),
      serverTime: Date.now(),
    }
  }

  /** 开启：清零本轮状态并立刻推进一次状态机（可能直接进入繁忙或空闲阶段）。 */
  const arm = () => {
    enabled = true
    lastError = ''
    sawActivity = false
    idleSince = 0
    phase = 'waiting'
    tick()
  }

  /** 取消/关闭：撤销本轮倒计时并关闭开关。 */
  const disarm = () => {
    enabled = false
    idleSince = 0
    phase = 'off'
  }

  /** 应用一份来自界面的设置改动；非法字段直接拒绝，不做静默兜底。 */
  const applyPatch = (body) => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, body: { ok: false, error: '请求体必须是 JSON 对象' } }
    }
    const { settings: next, problems } = normalizeSettings(body, settings)
    if (problems.length > 0) return { status: 400, body: { ok: false, error: problems.join('；') } }
    const enabledField = body.enabled
    if (enabledField !== undefined && typeof enabledField !== 'boolean') {
      return { status: 400, body: { ok: false, error: `enabled 必须是布尔值，收到 ${JSON.stringify(enabledField)}` } }
    }
    const changed = JSON.stringify(next) !== JSON.stringify(settings)
    settings = next
    if (changed) {
      try {
        saveSettings(settings)
      } catch (error) {
        const detail = `保存 ${SETTINGS_FILE} 失败：${String((error && error.message) || error)}`
        lastError = detail
        ctx.logger.error(`dsh-shutdown-idle: ${detail}`)
        return { status: 500, body: { ok: false, error: detail, ...publicState() } }
      }
      ctx.logger.info(`dsh-shutdown-idle: 设置已保存 → ${JSON.stringify(settings)}`)
    }
    if (enabledField === true) arm()
    else if (enabledField === false) disarm()
    else tick()
    return { status: 200, body: publicState() }
  }

  /** 路由处理：状态读取、设置写入、取消，以及兜底页面。 */
  const handleRoute = async (req, res) => {
    let path
    try {
      path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `无法解析请求路径：${String((error && error.message) || error)}` })
      return
    }
    if (path === `${UI_PATH}/api/state`) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      sendJson(res, 200, publicState())
      return
    }
    if (path === `${UI_PATH}/api/config`) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const applied = applyPatch(await readJsonBody(req))
        sendJson(res, applied.status, applied.body)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
      return
    }
    if (path === `${UI_PATH}/api/cancel`) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      disarm()
      ctx.logger.info('dsh-shutdown-idle: 用户取消倒计时并关闭开关')
      sendJson(res, 200, publicState())
      return
    }
    if (path === UI_PATH || path === `${UI_PATH}/`) {
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(renderPage())
      return
    }
    sendJson(res, 404, { ok: false, error: 'not found' })
  }

  // 冷启动时补丁层可能先于 webServer 挂载；注册报错（上一代 fiber 尚未卸载完）时轮询重试。
  const tryRegister = (webServer) => {
    if (disposed || routeDisposer !== null) return
    try {
      routeDisposer = webServer.register({ kind: 'prefix', path: UI_PATH, handler: handleRoute })
      ctx.logger.info(`dsh-shutdown-idle: 接口已挂载在 ${UI_PATH}`)
    } catch (error) {
      routeDisposer = null
      ctx.logger.warn(`dsh-shutdown-idle: 路由注册暂不可用（${String((error && error.message) || error)}），稍后重试`)
    }
  }
  ctx.inject(['webServer'], (scope) => {
    tryRegister(scope.webServer)
    if (routeDisposer === null && !disposed) {
      const stopRetry = ctx.interval(() => {
        routeRetries += 1
        tryRegister(scope.webServer)
        if (routeDisposer !== null || disposed || routeRetries >= ROUTE_RETRY_LIMIT) stopRetry()
      }, ROUTE_RETRY_MS)
      scope.effect(() => stopRetry, 'dsh-shutdown-idle: 路由注册重试')
    }
  })

  const stopTick = ctx.interval(tick, TICK_MS)
  ctx.effect(() => () => {
    disposed = true
    stopTick()
    if (routeDisposer !== null) routeDisposer()
  }, 'dsh-shutdown-idle: 心跳与路由')

  ctx.logger.info(`dsh-shutdown-idle: 已挂载（动作 ${settings.action}，空闲确认 ${settings.settleSeconds}s，倒计时 ${settings.countdownSeconds}s，要求先有会话运行 ${settings.requireActivity}，后台作业计入占用 ${settings.considerJobs}）；界面：设置 → 会话结束后关机，兜底页 http://127.0.0.1:3080${UI_PATH}`)
}