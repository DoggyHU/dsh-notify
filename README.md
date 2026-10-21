# dsh-notify — 任务提示音

DSH 需要你、或者一轮活干完的时候，用 **Windows 自己的声音**提醒你一声。
声音由 DSH 的本机进程播放，所以页面在后台、你切到了别的窗口、甚至标签被静音，都还听得见。
音效在**设置 → 任务提示音**里挑，点一下就能试听。

## 它什么时候响

| 时机 | 事件 | 声音 |
|---|---|---|
| 有东西等你点确认（工具授权、权限提升…） | `approval/request` | 「需要你确认时」选的那个 |
| 智能体问了你一个问题 / 等你审计划 | `user-questions/request` | 同上 |
| 主会话一轮跑完 | `agent/status` 由 `running` 变 `idle` | 「任务完成时」选的那个 |

**不会响的情况**：

- 子代理、Agent Teams 成员的会话结束（设置页里可以打开，默认关）；
- 会话只是被创建、或本来就没在跑时收到 `idle` —— 只有「先 running 再 idle」才算一轮结束；
- 两声之间小于「最小间隔」（默认 1200 毫秒）；
- 刚响过「需要确认」后的「静默窗口」内（默认 5000 毫秒），那是同一次卡住，不是两次事件；
- 总开关关掉时。

## 设置页

**设置 → 任务提示音**（在「模型」和「插件」之间）。

- 两块音效，各有一份 Windows 自带音效列表（实时读 `C:\Windows\Media\*.wav`，你机器上现在 63 个）。
  **点名字＝选中并试听，点 ▶＝只试听**。
- 「自定义 wav」一行：填绝对路径（比如 `D:\Sounds\ping.wav`），▶ 试听，`使用` 选中。
  文件不存在会直接告诉你是哪个路径找不到。
- 进阶：子代理是否也响、最小间隔、静默窗口。

配置存在 `C:\Users\Acer\.dsh\storages\dsh-notify.json`，可以直接手改，插件会在 0.5 秒内读到新值。

## 那两声到底是谁在放

一次性的隐藏 `powershell.exe`，脚本用 `-EncodedCommand`（Base64 UTF-16LE）传：
路径里有空格、引号、中文都不会被 shell 重新解释，`windowsHide` 保证不闪黑窗。
找不到 `.wav` 时退回 `[System.Media.SystemSounds]`，跟随你的 Windows 声音方案。

实测：事件发生到出声约 **0.7 秒**（PowerShell 启动开销）。

一个副作用值得知道：**音量合成器里这一项显示为 "Windows PowerShell"**，不是 DSH。
如果你哪天单独静音了某个应用，注意别把它也静了。

## 装 / 卸 / 改

- 安装：`plugin_manager` 的 `install_bundle`，target 指向本目录（首次）或包名 `dsh-notify`（已装过时）。
- 停用：设置 → 插件 里关掉这一行，或 `remove_bundle`。

### 改完必须「完全退出进程」，不是关窗口、也不是刷新页面

这一条值得单独写，因为它白白吃掉了三轮调试：

| 你做的动作 | 浏览器半边 | Host 半边 |
|---|---|---|
| 按 F5 / 重开窗口 | ✅ 会更新 | ❌ 还是旧的 |
| 插件里「禁用 → 启用」 | ✅ | ❌ **还是旧的**（Loader 复用启动时 import 的那一代模块，实测确认） |
| 完全退出 DSH 进程后重开 | ✅ | ✅ |

所以改完 `index.js`（或任何 Host 代码）之后，请**托盘图标右键 → 退出**，确认没有残留进程再打开：

```powershell
Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue
```

验证方法：看 `storages\dsh-notify.log` 有没有多出新的一行，比对比进程启动时间和源文件修改时间。
`install_bundle` 对已安装包的改动会明确回 `restart-required` —— 那就是"必须要真重启"的意思。

## 自检（不需要 DSH）

```powershell
node _diag\notify-host-test.mjs      # Host 半边：事件判定 / 节流 / 配置读写 / 试听接口（34 项）
node _diag\notify-client-test.mjs    # 浏览器半边：注册 / 三个渲染分支（23 项）
node _diag\notify-sound-test.mjs     # 直接听某个音效，例如 chimes.wav
```

Host 测试用临时 `DSH_HOME` 和一个静音 wav，所以不会动你的真配置、也不会出声。

## 踩过的坑：一个"注册不上但没人告诉你"的通道

第一版设置页能显示，但一读配置就报 `transport failure for /notify/get: HTTP 405`。
我最初把通道注册写成了这样：

```js
ctx.inject(['connection'], (c) => c.connection.rpc.handle('/notify', handler))   // ✗
```

第一次尝试的修法是补上 `webServer` 注入 —— **没用**，而且暴露了真正的原因。
幸好当时加了一行诊断日志，它把异常原文写了下来：

```
channel /notify registration failed: Error: cannot get property "webServer" without inject
    at Fiber.<anonymous> (…dsh-client-connection/lib/index.js:656:35)
    at Object.handle (…/lib/index.js:576:39)
```

`rpc.handle()` 里是 `owner.effect(() => owner.webServer.register(route), …)`，而 `owner` 来自
`get rpc() { const owner = this.ctx; … }` —— **`this.ctx` 是这个 service 自己的上下文**（connection 插件那个），
不是"读它的插件"。那个插件的 inject 列表是 `['credentials']`，没有 `webServer`，所以这行**必然抛错**。
换句话说：**在这个版本里 `rpc.handle()` 对插件是不可用的**（DSH 自己也从不调用它，只用不碰 `webServer` 的
`rpc.intercept('/api', …)`；而 `/api` 的拦截器已被 typertGateway 独占，`registerInterceptor` 明确禁止重复注册）。

失败之所以无声，是因为 Cordis 只丢掉抛错的子 fiber，**插件行仍然是 `active`**，页面那一侧只看到一个 405。

**最终用的是插件真能用的那个扩展点** —— `connection.fetch.register()`，它只往 Connection 的精确路由表里加一条，
全程不碰 `owner` 的任何 service：

```js
ctx.inject(['connection'], (c) => c.connection.fetch.register({
  path: '/api/notify.config',          // 必须在 /api 下
  methods: ['POST'],
  requestBody: 'buffered',
  fetch: async (request) => Response.json(await handleEndpoint(…)),
}))
```

路径**必须落在 `/api` 下**：Connection 自己为 `/api` 注册了 prefix 路由，那里做 Host/Origin 校验和
浏览器 Cookie 认证，然后把请求交给 `createSharedFetchHandler('/api')` —— 先查精确路由表，再查拦截器。
所以页面里一句普通的同源 `fetch('/api/notify.config')` 就自带认证，和整个 UI 走的是同一条路
（认证是签名 Cookie，`isAuthenticated()` 读 `cookie` 头，客户端默认就是 `globalThis.fetch`，不额外加头）。

教训：**这类失败不留任何痕迹**，所以 Host 半边每次启动都会往
`C:\Users\Acer\.dsh\storages\dsh-notify.log` 写一行"注册成功/失败 + 堆栈"，设置页遇到 404/405 也会直接点名这个文件。
回归测试里有三项盯着它：路由路径必须在 `/api` 下、声明必须是 POST+buffered、源码里**不得出现 `rpc.handle(`**。

## 实现要点

- `approval/request` 与 `user-questions/request` 是 waterfall 事件：本插件只观察，`next()` 在 try/catch
  **之外**调用且只调用一次 —— 提示音坏掉、甚至事件载荷一读就抛错，也不会让授权流程卡住（测试里专门有这一项）。
- 设置页数据走 `connection.fetch.register()` 的 `/api/notify.config`，浏览器半边用同源 `fetch`
  （不再需要 `connection` 客户端 service，所以 `inject` 只有 `slots` 和 `locale`）。
- 浏览器半边只用 `--dsw-alias-*` 主题令牌，不 import 任何 DSH 客户端包，不碰 app root，不往 `document.body` 追加东西。
