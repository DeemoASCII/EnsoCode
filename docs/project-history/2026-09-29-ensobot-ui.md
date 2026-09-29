# EnsoBot：交流优先的桌面界面

## 行为差距与范围

旧界面只有私聊/群聊列表；人物卡编辑挤在 340px 侧栏，已有留言板、工作区、任务接口没有入口。
本次在 Renderer 中重建信息层级，复用现有 IPC、人物卡 PNG 格式和节点协议；不改变后台调度、模型工具或授权语义。

## 界面决定

- 导航分为会话、成员、公共留言板、公共工作区。私聊/群聊常驻第二列，节点选择在底部。
- 聊天顶部单独展示真实任务状态；不伪造在线状态、时间戳或回复进度。
- 人物卡使用宽版弹窗，原图与圆形头像预览并列；人设与职能权限分区。导出前先保存当前编辑。
- 留言板显式选择点名成员；工作区展示排队、进行中和终态，绑定已有项目或会话。
- 复用 EnsoCode 的语义色、字体、背景图和独立窗控；输入区使用 `data-slot="composer"` 跟随独立透明度。
- Multica 仅参考公开产品结构，不移植其附加许可覆盖的代码。未使用 Grok 泄露源码。

## 文件职责

- `EnsobotPanels.tsx`：导航、成员、会话列表和节点级 UI 状态。
- `EnsobotChat.tsx`：消息、草稿、群聊创建和留言板。
- `CharacterCardDialog.tsx`：人设、模型权限、头像裁切和导出。
- `EnsobotWorkspace.tsx`：任务与公共工作区；会话目录只读，不为下拉框实例化可写会话 store。
- `useEnsobot.ts` / `ensobotView.ts`：节点快照隔离、回执、纯显示逻辑；相邻测试覆盖边界。

## 回归防线

- seq 只在同一节点内比较；换节点不能借用前一节点的选择、人物卡或草稿。
- 先订阅回执再发送；回执按 nodeId 和 deliveryId 匹配。有独立投递 ID 的聊天并行发送，无 ID 的旧协议操作在同节点串行。
- 编辑人物卡不因后台消息快照重置输入；发送成功不清掉用户在等待期间新写的内容。
- 输入法组合态 Enter 不发送；会话删除后回退到有效目标。

## 验证范围

隔离 userData 的 Electron CDP 已验证：空态、真实人物卡保存、弹窗下拉层级、建群、键盘发送、聊天草稿隔离、留言提交、浅/深主题、多窗口背景设置同步、800×560 无横向溢出。
测试数据和临时脚本不进入正式代码。未宣称跨厂商模型执行或两台物理节点联调已完成。

类型检查和改动文件 Biome 检查通过；EnsoBot 相关测试通过。
全量检查仍有非本次改动文件的 CRLF 格式问题，以及 Windows 路径/符号链接/命令环境与部分超时失败；不在 UI 改造中批量修复或跳过它们。

## 首次预发布审查：暂缓发布

对当前 `ade0816d` 加未提交 UI 的宿主行为做依赖可控的 Vitest 复现，8 个新增场景均未满足预期；原有宿主、Renderer 与 shared/ensobot 的 51 项测试仍通过。以下不是跨厂商真机验证结论，不能以已有 UI 冒烟通过替代后台行为验收。

1. 群聊 `ensobot-bubble` 无条件先写私聊，再写群；群消息会污染私聊历史。
2. 私聊轮仍在运行时，群点名立即覆盖卡片级 `speakRoomId`；原私聊的后续回复会被写进群。
3. 留言板点名投递后 `pending` 已清除，回复路由却依赖 `pending` 判断；正常回复不回留言板。
4. 背景任务投递失败虽回退 queued，却保留 `seen` 中的投递 ID；再次认领不再发给 worker。
5. 重建宿主时保留磁盘中的 `spawned/ready`，没有恢复已消失的 worker 会话；worker-exited 也被运行器直接忽略。
6. 收到 failed 状态只改 runtime，任务仍 doing 并继续占用目录与槽位。
7. `tool-output` 中出现检查文本就完成任务、唤醒等待者，没有等待当前轮退出；另一写入任务可在原轮仍运行时开始。
8. enqueue 发布 queued 后，claim/doing 未增加 seq；用真实 `applyEnsobotSnapshot` 消费推送，宿主已 doing 而界面仍 queued。

修复应落在 `src/main/services/ensobotHost.ts` 的投递身份、轮次生命周期、队列和快照契约，以及 `ensobotRuntime.ts` 的 worker 生命周期处理；不能靠放宽 Renderer 去重或禁用群聊/后台任务规避。修复时将上述场景转为长期回归测试，并补实际模型执行验证。

发布归属已确定：同 `J3n5en/EnsoCode` 仓库，独立 EnsoBot 安装包，标签 `ensobot-v0.0.1`，GitHub prerelease 且不设 Latest。仍须隔离应用身份、userData 与更新渠道；原 build 工作流使用 EnsoCode 身份并强制 `--latest`，不能直接复用发布步骤。
本轮只 fetch 了 EnsoCode 主线（`50104c92`，比当前分叉点多 7 个提交），没有合并、提交、推送、打标签或创建 Release。一次性复现测试及其临时目录已删除。

## 后续修复与验证

用户同意由当前会话直接修复；另外使用已配置的 inyx / `claude-fable-5-1`（Anthropic）和 inyx / `gpt-6-astra`（OpenAI）进行真实模型工具验收。

本批主要修改 `ensobotHost.ts`、`ensobotRuntime.ts`，并在 `agentHost.ts` 增加按需等待 worker 启动的方法。没有修改 Renderer 去重规则、worker 公共协议或发布配置，没有合并主线。

- 回复路由绑定实际送出的活轮，私聊、群、留言板互斥写入。跨聊天面的输入排队，同一聊天面仍保留 steer 补充；worker 延迟接收时保留原始投递来源，不再从私聊气泡猜路由。
- 任务 `doing` 只在投递成功后设置；发送失败清理任务投递的去重标记。检查结果属于实际启动的 task，而非碰巧共享 session 的 claimed 任务。
- 任务在 `turn-completed` 且工具检查通过时才 done；不再在工具增量或单独 idle 状态上释放目录。失败、检查未通过、中断有明确失败状态和原因，并唤醒等待者。
- 同时收集流式输出和最终 toolResult，按 toolCallId 替换。最终错误结果不能沿用中途的 PASS；没有流式更新的工具也可完成检查。
- 冷启动清理旧 spawned/ready/running 标记，保存 parent-ready 的 sessionFile，恢复时使用同一 JSONL、新 generation；拒绝旧代和过期序号事件。worker-exited、parent-ended、parent-rejected 不再被忽略。
- 已执行任务在崩溃/重启后记为中断失败，不擅自重放可能已经写盘的操作；尚未执行的 claimed 任务回 queued，可重新认领。worker 曾退出时下一次发送可按需启动并等待 spawn，不抢首次环境初始化。
- 每次快照推送递增并持久化独立 seq，任务状态、通知和卡片更新不会被 Renderer 当成旧快照；重启后序号也不回退。

### 回归防线

`ensobotHost.test.ts` 从 15 项扩至 36 项，并加强原群聊用例的「不写进私聊」断言；新增 `ensobotRuntime.test.ts` 2 项和 `agentHost.lifecycle.test.ts` 2 项。所有可测逻辑先确认 RED，再落实现。宿主、运行器、worker 生命周期及既有 shared/Renderer 相关测试合计 13 文件、80 项通过；类型检查及本批 6 个代码文件的 Biome 检查通过。

### 隔离真机证据

使用独立 userData 与 CDP 9555/9556/9557，不修改真实用户设置或会话。

1. 两模型均实际调用 ensobot_say：PRIVATE_OK / PRIVATE_LATE 仅落私聊，GROUP_OK 仅落群，BOARD_OK 仅落留言板。
2. 两模型执行 powershell 输出 ENSOBOT_TASK_PASS / FINAL_TASK_PASS，随后发送 TASK_OK / FINAL_TASK_OK；任务均在收到终态后 done。
3. 杀掉隔离 Electron 后冷启动，两模型继续原 JSONL、换新 generation，均返回 RESUME_OK。
4. 只杀隔离实例的 node utility worker，观察到一次 worker-exited；下一次发送自动恢复，两模型均返回 WORKER_RECOVER_OK，原会话文件未更换。

未把这些测试扩大解释为「可立即发布」：独立应用身份、userData/更新通道隔离和主线合并仍待做；两台物理节点尚未验证。全仓 Biome 仍报 390 个问题，以已有 CRLF 差异为主；全量测试仍有 Windows 路径、符号链接、RTK、配置同步等失败，不跳过、不混入本批重构。

最终生产构建通过（保留已有大 chunk 警告）。最后一次完整 Vitest 为 34 文件失败、507 通过、2 跳过；用例 86 失败、5718 通过、120 跳过，其中部分整组因导入/初始化 hook 超时而未运行，不是主动禁用测试。本批 `ensobotHost`、`ensobotRuntime`、`agentHost.lifecycle` 均通过；不能据此认定其它失败已全部排除影响。完整输出保留在本地忽略目录 `temp/ensobot-fixes-final-tests.log`，构建输出在 `temp/ensobot-fixes-build.log`。

测试期间同时跑两套 Vitest 曾使新增生命周期测试的动态模块导入超过单测 5 秒预算；将隔离模块初始化移入 beforeEach（未修改超时、断言或执行功能）后，相关 80 项重新通过。隔离 Electron/worker 已停止，含模型配置的临时 userData、一次性造卡脚本及验证产生的 `%SystemDrive%` 缓存目录已删除。全部修复仍为本地未提交，未推送、未建标签或 Release。
