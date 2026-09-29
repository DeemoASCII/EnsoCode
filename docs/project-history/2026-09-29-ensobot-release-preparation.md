# EnsoBot 0.0.1 发布准备

## 范围与基线

- 既有人物卡/交流 UI 独立提交 `f2191459`；路由与任务恢复修复提交 `28da9686`。
- 合入 `origin/main` 的 `50104c92`，合并提交 `4de4de84`。冲突仅在 worker 事件 union，保留 `ensobot-bubble` / `ensobot-interject-deferred` 和主线 `delivery-rejected`。
- 用户补充：左下角原有折叠侧栏、Ask Enso、设置三个按钮均保留；Bot 为第四个独立入口。`Sidebar.tsx` 对比主线仅新增 Bot，没有替换。隔离 CDP 9666 已验证展开与收起状态四按钮均可见，归档按钮仍按原条件出现。
- 用户原有 `.gitignore` 的 `references/` 忽略保持本地，不纳入提交。

## 发布隔离

所属层为构建配置、Main 启动/窗口身份与自动更新，不通过 Renderer 开关或运行时环境变量切换打包产品身份。

- `src/shared/product.ts` 与 Vite 构建常量：EnsoCode 默认不变，EnsoBot 固定为 `com.j3n5en.ensobot`，userData `ensobot`（开发默认 `ensobot-dev`）。
- `electron-builder.ensobot.yml` 复用原始依赖/原生模块打包配置，覆盖安装名 `EnsoBot`、package name `ensobot`、版本 `0.0.1`；原 `package.json` 版本仍为 EnsoCode `0.2.1`。
- `pnpm build:ensobot` 固定产品身份及设置页显示版本。保留配套工作台提供项目/会话/浏览器能力，另打开 EnsoBot 聊天窗；托盘恢复同样打开聊天窗。
- EnsoBot 更新从 GitHub releases 列表只选择严格 `ensobot-vX.Y.Z` 标签，使用该 tag 的 generic feed / `ensobot*.yml`。不读取 `/latest`，请求错误显式展示且不回退 EnsoCode。实际包内更新缓存为 `ensobot-updater`。
- 独立 `EnsoBot Preview` 工作流：完整 typecheck/lint/test → 四组打包与原生模块冒烟 → 合并 mac 元数据、SHA256 → `gh release create --prerelease --latest=false --verify-tag`。原 `v*` 工作流不改，不发布 relay。
- builder 的 `publish` 需用单元素数组覆盖：对象形式会从父配置混入 GitHub owner/repo/releaseType，导致 generic schema 校验失败。以打包器实际合并结果复核，不只检查 YAML 字面值。

## 验证与环境差异

- Windows 生产构建与 NSIS 安装包已生成于本地 `dist/ensobot/EnsoBot-Setup-0.0.1.exe`，仅生成专属 `ensobot.yml`，未上传。
- 打包 Electron 的原生模块冒烟通过：better-sqlite3 + sqlite-vec、classic-level、node-pty、node-datachannel、pi-tui、ripgrep、RTK。
- 实际打开打包 EnsoBot，主窗口标题 `EnsoBot`、进程响应正常，生成全新 `appData/ensobot`，没有启用打包 CDP。测试前该目录不存在，验证后停止进程并删除测试数据。
- Windows 原工作区存在 CRLF 格式差异；从 Git archive 构造 Linux 干净源码后 lint 无错误（已有 warnings），不对全仓做无关格式化。
- Ubuntu 22.04 自带 Git 2.34 不支持代码已使用的部分选项；权限测试不能以 root 运行。验证改用普通用户 + 独立 Git 2.48.1 + 项目 Node 22.22.2 与 pnpm 10.26.2，不修改测试断言或关闭用例。
- OAuth 测试已有共享 fetch mock，`spyOn` 继承前面用例的调用记录；仅在本用例动作前 `mockClear`，仍要求未知账号查询零网络请求。
- 启动测试隔离 shell 探测并先收口上个用例的 deferred startup，避免未结束的 setImmediate 跨用例污染 worker 调用次数。
- 最终标准 Linux 门禁 `pnpm typecheck && pnpm lint && pnpm test` 退出 0：547 文件通过、1 文件原有跳过；5974 用例通过、5 用例原有跳过。完整输出在本地 `temp/ensobot-linux-gate.log`。一次性 Linux 执行脚本已删除。该全绿结果不覆盖下面新发现、尚无长期测试的审批缺口。

## 审查时发现的发布阻塞：审批/问答没有 EnsoBot 宿主（后续已修复）

**该次审查不能发布当时的包。** 默认人物卡 `EMPTY_ROLE.approvalScope` 是 `supervised`，工具会实际停在 `ApprovalGate`；但当时 `observeEnsobotWorkerEvent` 的白名单不转交 `approval-request` / `ask-request`，EnsoBot snapshot 与界面也没有 pending 审批/问答及回应入口。普通工作台不会自动登记 Bot 的独立 session，不能充当其交互宿主。

两个一次性运行器复现测试分别输入真实类型的审批与问答事件，期望进入宿主，结果均为零调用（2/2 失败）；复现文件用完立即删除。该证据验证的是事件链路，不冒充真实模型端到端权限验收。此前两厂商工具验证使用 `full`，不能覆盖默认 supervised 行为。

后续必修完整路径：worker 请求 → Main 按人物卡与当前 generation 建权威 pending → EnsoBot 本地/远端投影 → UI 允许/拒绝/回答 → typed IPC 或节点协议 → Main 校验卡、请求与代次 → worker；还须处理 resolve、重载、退出、重复回应、过期 generation，以及两厂商默认权限真机验收。不能仅扩大白名单、禁用 ask_user、隐藏审批档位或改为默认 full。

本轮不推送发布标签、不创建 GitHub Release；安装包仅为本地验证产物，不代表可分发版本。

## 后续审批/问答修复与验收

- `ensobotInteractions.ts` 在 Main 内存持有请求和真实 worker identity，人物卡与根 generation 由宿主/AgentSessionIndex 确认；Renderer 只拿随机令牌与卡 id，不能指定执行会话或权限代次。
- 新 typed IPC `ENSOBOT_RESPOND` 和节点协议 `ensobot-respond` 共用 `parseEnsobotResponse`。该回应通道不作为模型可调用 capability。
- snapshot 携带 pending 交互，EnsoBot 所有页面顶部均可回应；复用 ApprovalBar / AskBar，不改默认 supervised，不靠普通 conversation store 接收 Bot 事件。
- 相同回应幂等；冲突决定、错卡、旧代、代审中人工抢答、离线均拒绝。成功发送等待 worker resolved，传输失败保留请求可重试。worker 退出清空，进程冷启动不重放授权。
- worker snapshot 可补漏，已 resolved 的请求不会被迟到 snapshot 复活；根/子会话序号独立，回应保留完整 child identity，不丢 parent/instance 信息。
- 新增解析器、交互生命周期、运行器接线、远端解析回归；最终完整 Linux typecheck/lint/test 通过（550 文件、5983 项通过，5 项原有跳过）。Windows 独立 NSIS 重打包及原生模块冒烟通过。
- 独立 userData / CDP 9777，inyx `claude-fable-5-1` 与 `gpt-6-astra` 两模型均采用 supervised。真实工具轨迹确认：允许后 `APPROVAL_PASS` / `ALLOW_FINAL` 才执行；拒绝结果为 `User denied this operation`，不出现 DENY_PROBE 命令输出；ask_user 获得「拒绝已确认」后均返回 `DENY_BRANCH_OK`。
- 待审批时重载窗口，两请求 id 保持不变且重新出现；点击允许后两模型均返回 `ALLOW_FINAL_OK`，pending 清空。远端结构/投递有回归测试；两台物理节点互联仍未做专项验收。

是否公开以本次 GitHub 发布工作流最终结果为准；本地测试通过不能替代平台打包和原生模块检查。
