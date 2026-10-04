# Playwright 连上 Electron 后卡死，自动化测试一步都走不了

## 症状

- `chromium.connectOverCDP(...)` 和 `_electron.launch(...)` 都在“ws connected”之后 30s 超时。
- 应用本身正常：日志里有 `DevTools listening`，两个窗口都画出来了，手工 CDP 脚本也能 eval。
- 换一个空 userData 也一样，与数据无关。

## 根因

工作台是“BrowserWindow + 固定的 WebContentsView”（`createPinnedWorkbench`）：真正的渲染器在
WebContentsView 里，**BrowserWindow 自己的 webContents 从不加载页面**。它照样以 `type: "page"`、
空 url 出现在 CDP 目标里，但对 `Page.enable` / `Page.getFrameTree` 永不回复。

Playwright 的整浏览器连接会自动附着所有 page 目标，并等每个目标初始化完才返回，于是被这个空页面永久挂住。
`pw:protocol` 日志里能看到只有这个 sessionId 的请求没有回包。

第二个坑：Windows 上 `taskkill /T /F` 结束主进程后，GPU/网络子进程还会收尾一会儿并占着 userData，
立刻重启同一 userData 会报 `process_singleton_win.cc ... Lock file can not be created! Error code: 32`
并以 0 退出；删除临时目录也会 EPERM。

## 修法

- 不用整浏览器连接：从 `/json/list` 找 `ensobot.html` 的 page 目标，直接连它自己的
  `webSocketDebuggerUrl`（`e2e/ensobot/cdp.ts`）。用 `Input.dispatchMouseEvent` / `Input.insertText` /
  `Input.dispatchKeyEvent` 发受信任事件，行为与真人输入一致。
- 不改产品去给宿主窗口加载 `about:blank`：那会改变窗口背景与透明背景图的表现，只为迁就测试工具。
- 结束实例后等主进程 `exit`；重启拿不到单实例锁（以 0 立即退出）就稍等重试；删临时 userData 时轮询重试。

## 回归防线

`pnpm test:e2e:ensobot` 的“重启后：群、主持人和讨论记录都还在”用例覆盖结束—重启—再连接的整条路径。

## 相关代码

- `src/main/windows/createAppWindow.ts`（`createPinnedWorkbench`）
- `e2e/ensobot/cdp.ts`、`e2e/ensobot/harness.ts`
