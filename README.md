# dsh-shutdown-idle

DSH 插件：**开启后，等所有会话都结束（没有任何 Agent 在跑）并保持空闲，自动执行关机**（也可选重启 / 休眠 / 睡眠 / 锁定 / 注销）。

## 用起来

1. 打开「设置 → 会话结束后关机」，点 **开启**。
2. 正常派活给任意会话；所有会话的回合结束后，插件先等 `空闲确认` 秒，再进入 `倒计时` 秒。
3. 倒计时结束即执行所选动作。期间任何会话重新开始运行，或点界面上的 **取消**，这次动作都会被撤销。

右上角（浮层右下角）在开启后会常驻一张小卡片，显示当前阶段与剩余秒数，并带「取消」按钮。**按住卡片标题即可拖动**：松手后位置写进浏览器 `localStorage`（键 `dsh.shutdown-idle.pill.position`），下次打开停在原处；拖动过程始终夹在视口内（留 8px 可见），窗口变小也会自动收回视野。从「取消」按钮上按下不会误触发拖动。

## 判据

- **会话进行中** = `ctx.get('agents').list()` 里存在 `status === 'running'` 的 Agent（与 dshmarket 的更新守卫同一判据）。这一条固定生效，不可关闭。
- **后台任务** = `ctx.get('jobs')` 中 `status === 'running'` 的作业（含各存活会话名下的作业），即 DSH 界面里的「后台任务」；由配置项 `considerJobs` 决定是否检测，关掉后完全不再统计。
- 拿不到 `agents` 服务时按 **不空闲** 处理：宁可不执行，也不误关机。
- 「必须观察到会话运行过」默认开启：刚开启且没有任何任务时不会执行动作。

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 动作 | `shutdown` | `shutdown` / `restart` / `hibernate` / `sleep` / `lock` / `logoff` / `none`（`none` = 只记录不执行） |
| 空闲确认 | 20 秒 | 全部空闲后先确认这么久，避免回合间隙被误判为结束 |
| 倒计时 | 60 秒 | 可取消的执行前倒计时 |
| 必须观察到会话运行过 | 是 | 防止刚开启就执行 |
| 后台任务也算占用（`considerJobs`） | 是 | 关掉后完全不再检测后台任务（shell 作业） |

设置页把这几项收在「什么算『还在忙』」区块里：会话在跑固定算忙，下面两个复选框是配置项。

初始值来自本包 `cordis.patch.yml` 的行 `config`；界面改动写入 `<DSH_HOME>/dsh-shutdown-idle/settings.json` 并优先生效（删除该文件即回落到 patch 初始值）。

**开关状态不持久化**：宿主重启后一律是「关闭」，避免开机即误关机。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-shutdown/api/state` | 开关、阶段、倒计时、运行中会话/作业 |
| POST | `/dsh-shutdown/api/config` | `{ enabled?, action?, settleSeconds?, countdownSeconds?, requireActivity?, considerJobs? }` |
| POST | `/dsh-shutdown/api/cancel` | 取消倒计时并关闭开关 |
| GET | `/dsh-shutdown` | 客户端半不可用时的兜底页面 |

## 平台

动作命令是 Windows 自带的 `shutdown` / `rundll32`。非 Windows 平台上，除 `none` 外的动作会被降级为 `none` 并在界面标注，不会执行命令。

## 字段一览

- `host.v2.mjs` — Host 半：状态机、HTTP 接口、命令派发、兜底页面。（`host.v1.mjs` 为上一版，保留以便回滚。）
- `client.js` — 浏览器半：设置页分区 + `shell.overlay` 浮层卡片（可拖动，`useDraggable` 负责指针捕获、边界夹取与位置持久化）。
- `cordis.patch.yml` — bundle 补丁：插入插件行与初始配置。

升级宿主半代码时换文件名（`host.v1.mjs` → `host.v2.mjs`）并同步 `package.json` 的 `main` / `exports`：config-only 热重载不会重新加载同一路径的模块。