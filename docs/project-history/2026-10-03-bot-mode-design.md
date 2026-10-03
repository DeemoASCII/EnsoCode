# Bot 模式设计

状态：已确认（采用「待确认」中的建议答案）。基于 `main@6382922c7` 重新设计，不继承 `EnsoBot` 分支的代码、数据和独立安装包方案。界面设计稿见 [`2026-10-03-bot-mode-mockup.html`](2026-10-03-bot-mode-mockup.html)。

## 目标

同一个 EnsoCode 应用里并存两种模式：

- **Code 模式**：保持现状（项目 → 会话 → worktree / diff / plan / subagent）。
- **Bot 模式**：一组有人设的 AI 成员。可以私聊、拉群，成员之间可以委派工作，每个成员有长期记忆，可以定时执行例行任务。成员真正干活时，复用 Code 模式同一套 worker、工具、审批和会话持久化。

不分期，以下全部属于本次交付。

## 参考结论

| 来源 | 采纳 | 不采纳 |
|---|---|---|
| akeru-bot（T3 Code fork） | 群聊每轮单一回复人（@ 优先，其次群主）；委派=子会话+结果只投递一次；权限取父子交集；重启时未完成委派判失败、不重放；按 bot/群划分记忆 | 隐藏项目概念；事件溯源整套重写；远程沙箱、外部渠道、语音 |
| OpenGrokBot | 成员 scope 一句话驱动路由；轮次上限防循环 | 每条消息由分派器选 1–3 人同时回复 |
| 旧 EnsoBot 分支 | 教训：自建气泡 / snapshot / 留言板 / 任务队列，与 jsonl 形成两套权威源，串聊和 seq 回退都出在这里 | 全部 |

## 关键事实（main 现状）

- 会话权威是 Main `SourceAuthorityRegistry` 的 `ConversationAuthority{conversationId, projectId, kind:'root', lifecycle}`（`src/shared/types/agent.ts:748`），会话必须挂在 active 项目下，cwd 只能是项目路径或已登记的 worktree（`src/main/ipc/agent.ts:245`）。正文的权威源是 pi jsonl。
- 所有会话共用一个 utility worker。事件按 `seq/generation` 单调递增，经 `broadcastAgentEvent` 广播到所有窗口。
- 人设可以复用 `systemPrompt → replacePersonaParagraph`（`src/agent/supervisor.ts:493`）：只替换 pi 开头的角色段，工具说明和规则保留。
- 子代理只有一层（child 不带 subagent 工具），`AgentService` 的 owner 只有 `chatSession`，child 一律折算到根会话。
- capability 授权只开放给 `agent:enso` locked child。
- 记忆空间只有 `global` 和 `proj:<id>`（`src/main/services/memory/types.ts`）。
- 没有定时器、调度器。
- 新增 UI 模式可以照远程节点的做法：`App.tsx:315` 整块切换，另写 Sidebar / Chat；`MessageTimeline`、`Composer`、`ChatHostContext`、`ApprovalBar`、`AskBar` 都靠 props 驱动，可以直接复用。

## 总体架构

```text
Renderer  ModeSwitch ─┬─ Code（现状不变）
                      └─ Bot: BotSidebar / BotChatView / BotProfilePanel / BotInbox
                              │ 只传 botId / chatId / messageId
preload   window.electronAPI.bots.*  (typed)
Main      services/bots/
            botStore          成员档案（文件）
            chatStore         私聊/群聊元数据 + 群聊记录（jsonl）
            botSessionHost    (chatId, botId) → 根会话；spawn/恢复/投递/收尾
            groupRouter       纯函数：谁回复、轮次上限
            groupTranscript   纯函数：给某成员的增量上下文
            delegationService 委派记录、并发/深度、结果投递
            routineScheduler  定时例行任务
          复用：SourceAuthorityRegistry / agentHost / AgentSessionIndex / memoryHost
Worker    复用 pi 会话；新增 bot 扩展：人设段 + 群上下文 + delegate/check_delegation 工具
```

核心原则只有一条：**一个成员在一个聊天里 = 一个普通根会话（pi jsonl 是权威）**。Bot 模式不另建消息存储，只有群聊的「谁说了什么」时间线由 Main 单独保存。这条时间线只写入最终消息，不写过程，不和会话正文重复。

## 数据模型

### Bot（成员）

存放在 `userData/bots/<botId>/`：`bot.json` 存结构化字段，`persona.md` 存人设正文，`avatar.png` 存原图。大段文本不进 `settings.json`。

```ts
interface BotProfile {
  id: string;
  name: string;              // 群内 @ 用，唯一（大小写不敏感）
  title: string;             // 头衔，如「后端」
  scope: string;             // 一句话职责，用于路由提示和委派目录
  avatar: { crop: CircleCrop | null; color: string };
  engine: { providerId: string; modelId: string; thinkingLevel?: ThinkingLevel };
  approvalMode: ApprovalMode;            // 复用现有档位，新建默认完全放行（full）
  tools: 'all' | 'readonly' | { allow: string[] };
  skillIds: string[]; mcpServerIds: string[];
  home: { kind: 'bot-home' } | { kind: 'project'; projectId: string };
  delegation: { canDelegateTo: 'any' | string[]; acceptFrom: 'any' | string[] };
  memory: { enabled: boolean };
  archivedAt?: string;
  version: number;
}
```

- 名字不能与内置 agent 类型重名（大小写不敏感）。
- **归档**（默认的「删除」）：从列表隐藏，私聊、记忆、例行任务全部保留，可恢复；例行任务暂停。**彻底删除**需二次确认，级联删除其私聊、委派会话、`bot:<id>` 记忆、例行任务和成员 home；所在群的历史发言保留（显示为「已删除成员」），群里不能再 @ 他；他若是群主，删除前要求先换群主。
- 支持人物卡 PNG 导入导出（tEXt `chara` 字段，兼容 SillyTavern V2 的 name/description/personality/scenario）。导入时生成新 id，不覆盖已有成员。
- **bot 自己的工作区**：每个成员在 `userData/bots/<botId>/workspace` 下有一个隐藏项目，`ProjectAuthority.kind = 'bot-home'`，Code 侧栏不显示。这样会话、记忆这些以 projectId 为键的链路都不用改，只需要在列项目的地方过滤掉 `bot-home`。

### Chat（聊天）

存放在 `userData/bot-chats/<chatId>/chat.json`。

```ts
interface BotChat {
  id: string;
  kind: 'direct' | 'group';
  title: string;
  members: string[];          // direct 恰好 1 个
  bossBotId: string | null;   // group 必填
  workspace:
    | { kind: 'member-home' }                     // 仅私聊：成员自己的 home
    | { kind: 'chat-home'; projectId: string }    // 仅群聊：独立目录（隐藏 bot-home 项目）
    | { kind: 'project'; projectId: string };     // 基于 Code 项目
  routing: { maxHops: number; maxTurnsPerBot: number };  // 默认 4 / 2，均按每条人类消息计
  pinned: boolean; archivedAt?: string;
  sessions: Record<string /*botId*/, { conversationId: string; cursor: number }>;
  version: number;
}
```

- 私聊可以点「新对话」：在同一私聊里开一个新根会话，旧会话进资料面板「历史」页签，只读。群聊不提供。
- 成员 home 和群的独立工作区都放在 userData 下，UI 提供「在访达中打开」。
- 私聊：`workspace` 默认为成员自己的 home，也可以改绑某个 Code 项目。改绑之后另开一个新会话，旧会话只读保留（与 Code 模式切项目的语义一致）。
- 群聊：所有成员共用同一个工作区，**新建群聊时二选一**：
  - **基于 Code 项目**：从 Code 侧栏现有的本地项目中选一个（不列出 ssh 项目），成员直接在该项目目录里读写。项目的 AGENTS.md、技能和项目信任确认与 Code 会话完全一致，和成员人设同时生效。群不会出现在 Code 侧栏，Code 项目也不会因此改变。
  - **独立工作区**（与 akeru / OpenGrokBot 相同）：在 `userData/bot-chats/<chatId>/workspace` 建一个空目录，登记为隐藏的 `bot-home` 项目。
  - 两种都会提示「群内成员共享这个目录」。之后可以在群信息里改选，改选后所有成员各开一个新会话，旧会话只读保留，时间线不变，cursor 重置到当前末尾。
  - 绑定的 Code 项目被移除时，群变为只读，并提示重新选择工作区；独立工作区随群删除一并清理。
- 每个成员在每个聊天里有自己的根会话，记在 `sessions[botId]` 里。`ConversationAuthority` 新增可选字段 `bot?: { botId; chatId }`，由 Main 写入，renderer 不能指定。

### 群聊时间线

存放在 `userData/bot-chats/<chatId>/timeline.jsonl`，只追加，每行一条：

```ts
type GroupEntry =
  | { seq; id; at; kind: 'human'; text; attachments?; mentions: string[] }
  | { seq; id; at; kind: 'bot'; botId; text; conversationId; turnId }      // 成员一轮的最终回复
  | { seq; id; at; kind: 'delegation'; delegationId; from; to; state; summary? }
  | { seq; id; at; kind: 'system'; text };                                  // 加人/改名/路由上限
```

- `seq` 在单个聊天内单调递增，由 Main 分配。推送和分页都按 seq 走。
- 成员回复取自 worker 的 `turn-completed` 里最后一条 assistant 文本（权威），不需要额外的 say 工具。工具过程留在该成员的会话里，UI 可以展开查看。
- 私聊不写时间线，直接显示那一个会话的正文。

### Delegation（委派）

存放在 `userData/bot-chats/delegations.jsonl`，内存里有投影。

```ts
interface Delegation {
  id; parentConversationId; parentBotId; targetBotId; chatId: string | null;
  task: string; context: string;            // context ≤ 8k 字符
  childConversationId: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  failure?: 'interrupted' | 'timeout' | 'denied' | 'error';
  result?: string; deliveredAt?: string;    // 只投递一次
  depth: number; createdAt; finishedAt?;
}
```

### Routine（例行任务）

存放在 `userData/bots/<botId>/routines.json`：`{id, title, prompt, schedule: cron, chatId, enabled, lastRunAt, lastResult}`。触发后作为一条系统发起的消息投进指定聊天。

## 关键流程

### 私聊发送

1. Renderer 调用 `bots.send({chatId, text, attachments})`。
2. Main 校验 chat 存在且成员未归档，再按 `chat.sessions[botId]` 解析出会话：没有就新建（authority + spawn），休眠中就带 resumeFile 恢复，正在运行就走现有的 steer 插话。
3. 之后的事件走现有的 `AGENT_EVENT`，由 sessions store 的 reducer 归并。BotChatView 直接用该会话的投影渲染。

先确认能发给 worker 再做 optimistic echo；被拒绝时不回显（AGENTS.md 约束）。

### 群聊发送与路由

`groupRouter` 是纯函数，输入是人类消息和当前状态，输出是回复队列：

1. 消息里有 `@成员` 时，按出现顺序逐个回复，`@所有人` 展开成全体成员，按成员顺序排；
2. 没有 @ 时由群主回复；
3. 成员在回复里 @ 了别的成员，就把被 @ 的人追加到队列末尾（去重，跳过自己）。同一条人类消息之后最多 `maxHops` 跳，且每个成员最多回复 `maxTurnsPerBot` 次，超出时写一条 system 提示；
4. 同一时刻每个群只有一个成员在回复（FIFO），保证时间线顺序就是对话顺序；全局同时最多 4 个 bot 会话在跑（私聊、群聊、委派、例行任务合计，Code 会话不计），其余排队并显示「排队中」；
5. 系统写入的条目（委派结果、system 提示）不参与路由，其中的 @ 不触发接力。

轮到某成员时，`groupTranscript` 生成增量上下文：从该成员的 `cursor` 之后，除他自己以外的所有条目，格式是 `<group-message from="Alice" role="后端" reply-to="…">…</group-message>`；最多 40 条，更早的写成「省略 N 条」；最后一条是触发他的那条消息。Main 把这段作为该成员会话的一条用户输入投进去。投递成功就推进 cursor（不论之后这一轮成功、出错还是 skip，避免重复注入），投递失败则 cursor 不动、队列项回退。

**跳过**：成员这一轮的最终回复如果只有 `[skip]`，不写入时间线，也不解析 @。Bot 模式说明里告诉成员：没有要补充的就回 `[skip]`。

**人类插话**：有成员正在回复时，新的人类消息先写入时间线。
- 它只 @ 了当前回复人：steer 进当前这一轮；
- 其他情况：当前这一轮照常说完，然后**丢弃剩余的接力队列**，按这条新消息重新路由（跳数和次数重新计）。短时间连发的多条会在这个边界合并成一次路由。

**成员会话之间互不影响**：每个人的会话只看到自己经历过的上下文，再加上群时间线的增量。压缩和恢复都只发生在单个会话内部。

### 委派

bot 会话额外挂两个工具：

- `delegate({to, task, context?, wait?})`：校验 `canDelegateTo/acceptFrom`；群聊里只能委派给本群成员；深度 ≤ 2，单个父会话并发 ≤ 3。通过后为目标成员新建一个**委派会话**（根会话，`bot.chatId = null`，`parentDelegationId` 有值，不出现在聊天列表），立刻返回 `delegationId`。
- `check_delegation({id?, cancel?})`：查看状态或取消。

**权限**取两边交集：工具集交集，审批档取更严的一档，工作区沿用父会话的工作区（被委派的人在委托方的目录里干活）。

**完成判定**：子会话 `turn-completed` 且这一轮没有以错误或中断结束，才算完成；result 取最后一条 assistant 文本。

**结果投递**：复用 `ParentNotifier` 的形态。父会话空闲时注入 `<delegation-result>` 唤醒它；父会话忙时排到本轮结束之后。投递成功后写 `deliveredAt`，保证只投一次。在群聊里，同时向时间线写一条 `delegation` 条目，并以被委派成员的名义写一条 `bot` 消息；这条消息不触发路由（见路由规则 5）。

**重启**：在 worker 恢复之前，把所有 queued 和 running 的委派标为 `failed/interrupted`，不自动重放（可能已经写盘），并通知父会话。用户可以在 UI 里点「重试」，重试会生成一条新记录。

**超时**：默认 4 小时，可以按成员配置。

Code 模式现有的 `subagent/workflow` 对 bot 会话照常可用，用于临时开的一次性助手，和委派不是一个概念，互不影响。

### Code 模式里调用 bot

成员会登记成 agent type `bot:<botId>`，在 @ 补全里单独成组并标注「成员」。Code 会话里可以用 `@成员名` 或 `subagent agent_type=bot:<id>` 拉他当 coworker，人设、模型、工具都按成员档案来，工作区是当前 Code 会话的目录。走的是现有的 child 链路，不新建委派记录。

### 记忆

- 新增空间：`bot:<botId>`、`chat:<chatId>`（群）。需要修改 `isSpaceId`、`resolveSpaceIds`、工具 schema 的 `spaceId` 枚举（新增 `bot`、`chat`）和蒸馏归属。
- bot 会话默认检索顺序：`bot` → `chat`（仅群聊）→ `project`（工作区是 Code 项目时）→ `global`。`capture` 默认写入 `bot`。
- 自动蒸馏：bot 会话很少「结束」，因此除会话结束外，在空闲释放（30 分钟）和私聊「新对话」时各蒸馏一次增量（记录已蒸馏到的 entry，避免重复）。归属按 `ConversationAuthority.bot` 推导出 bot/chat 空间。
- Bot 资料面板里可以查看、编辑、删除该成员的记忆。

### 人设与提示词

Main 在 `spawnSession` 里根据 `ConversationAuthority.bot` 组装提示词，renderer 不传正文：

1. `systemPrompt`（角色段）= persona.md + 名字、头衔、职责；
2. `instruction` 追加「Bot 模式」说明：回复要像聊天一样简洁，最终正文就是发出去的消息，怎么委派，群里有哪些成员（名字、头衔、scope 目录）；
3. 模型、工具、技能、MCP、审批档都取自 BotProfile，可以被群聊或委派的交集收紧，不能放宽。

修改人设只影响新会话或下一次恢复；进行中的轮次不变。

### 审批与提问

- 不新增通道，沿用 `AGENT_APPROVAL_RESPOND` / `AGENT_ASK_RESPOND` 的 exact identity 校验。
- Bot 模式新增**收件箱**：汇总所有 bot 会话和委派会话里待处理的审批和提问，并在对应聊天里内联显示 ApprovalBar / AskBar。后台成员发起审批时给出桌面通知，聊天列表标红点。
- 委派会话的审批归在发起委派的聊天名下显示，并注明「X 替 Y 执行」。
- 新成员默认完全放行，只有用户手动调严时才会出现审批。出现时一直等待（桌面通知 + 手机推送 + 收件箱），不超时；委派受 4 小时总超时约束；例行任务触发的轮次里，审批 30 分钟无人处理自动拒绝。

### 手机端

- pair 协议新增可选帧（旧手机忽略不认识的帧）：
  - 下行 `bot-catalog`（成员摘要：id、名字、头衔、头像缩略图、状态，不含人设正文）、`bot-chats`（聊天列表、未读、最后一条）、`group-timeline`（按 seq 分页，单帧 < 850KB）、`bot-event`（同桌面 `BOT_EVENT`）；
  - 上行 `bot-send {chatId, text, attachments?, deliveryId}`、`bot-chat-open {chatId}`、`bot-timeline {chatId, beforeSeq}`。新命令同时登记到 `PhoneToHost`、`PHONE_COMMAND_TYPES`、`parsePhoneCommand` 和 handleFrame。
- `bot-send` 走和桌面 `BOT_SEND` 同一个 Main 服务，校验一致；主窗口不在时由 headless 的 `pairSessionHost` 承接。
- 私聊：手机订阅该聊天当前成员的会话，复用现有 `agent-event` / `session-sync` / `history` 和消息渲染。群聊：订阅 `chatId`，拿时间线；点「查看过程」时再按需订阅对应成员会话。
- 审批和提问复用现有手机链路（按 exact identity 校验）。后台成员发起审批时和 Code 会话一样发 Web Push。
- 手机端只做：成员和聊天列表、私聊、群聊（含 @ 补全）、审批与提问、委派卡片的取消。新建/编辑成员、新建群、例行任务管理留在桌面。
- 现有 Code 目录（`CatalogEntry`）仍然过滤掉 `bot-home` 项目和 bot 会话，Bot 内容只通过上面的专用帧出现。

### 例行任务

`routineScheduler` 在 Main 里用 cron 解析器计算下次触发时间，用单个 timer 驱动。触发时如果目标聊天正在忙就排队。如果应用没在运行，错过的触发不补跑，只在 UI 上标出「错过 N 次」。headless 托盘模式下照常运行。

## UI

- **模式切换**：侧栏顶部 NodeSwitcher 旁边放 `Code | Bot` 分段控件，存到 `localStorage['enso-mode']`。只在本机生效：切到远程节点时隐藏切换并回到 Code 视图。快捷键、标题栏按钮、SidePanel 照远程节点的做法按模式屏蔽。
- **BotSidebar**：
  - 私聊区：每个成员一行，显示头像、名字、最后一条消息、未读点、运行中动效；
  - 群聊区；
  - 置顶、归档；
  - 底部入口：新建成员、新建群、收件箱、设置。
- **BotChatView**：
  - 私聊：`MessageTimeline` 渲染该会话，头像和名字用成员档案。
  - 群聊：渲染时间线条目，每条 bot 消息带「查看过程」，展开后内嵌该成员会话这一轮的工具过程（只读）；委派条目显示为卡片，可以取消或重试。
  - 输入框复用 `Composer`，支持 @ 成员补全；工具栏是工作区徽标、成员模型（私聊）、审批档。
  - 必须提供 `ChatHostContext`，避免 retry、fork 落到 Code 模式的当前会话上。
- **BotProfilePanel**（右侧）：人设、头衔/scope、模型、工具/技能/MCP、审批档、工作区、委派权限、记忆、例行任务、历史会话、导入导出人物卡。
- **新建成员**：从空白开始、导入人物卡，或者从内置模板（经理 / 全栈 / 运维 / 测试 / 设计）创建。
- Code 模式的 Sidebar、ChatView 只增加一处过滤：`bot-home` 项目和带 `bot` 字段的会话不显示。

## 新增 IPC（通道常量 + Main handler + preload typed 出口）

- `BOTS_LIST / BOT_SAVE / BOT_ARCHIVE / BOT_DELETE / BOT_IMPORT_CARD / BOT_EXPORT_CARD / BOT_AVATAR`（导入走 Main 文件对话框，不接收 renderer 传入的路径）
- `BOT_CHATS_LIST / BOT_CHAT_CREATE / BOT_CHAT_UPDATE / BOT_CHAT_DELETE / BOT_CHAT_TIMELINE(chatId, beforeSeq)`
- `BOT_SEND(chatId, text, attachments, deliveryId)`
- `BOT_DELEGATION_CANCEL / BOT_DELEGATION_RETRY`
- `BOT_ROUTINE_SAVE / BOT_ROUTINE_DELETE / BOT_ROUTINE_RUN_NOW`
- 推送 `BOT_EVENT`：`{kind:'catalog'|'chat'|'timeline'|'delegation'|'routine', chatId?, seq}`，按 chatId 去重，过期 seq 丢弃。

所有入参都按 `unknown` 收窄。

## 必改文件（主要）

| 层 | 文件 |
|---|---|
| shared | `types/agent.ts`（ProjectKind 加 `bot-home`、ConversationAuthority 加 `bot`）、新 `types/bot.ts`、`characterCard*.ts`、`bots/router.ts`、`bots/transcript.ts`、`ipc` 常量、`i18n.ts` |
| main | 新 `services/bots/*`、`ipc/bots.ts`；`ipc/agent.ts`（persistedRootSpawn 接受 bot-home、spawn 组装 bot 提示词）、`agentHost.ts`、`sourceAuthorityRegistry.ts`、`memory/*`（空间）、`agentTypes`（`bot:<id>`）、`pairHost`/`pairPolicy`/`pairSessionHost`（bot 帧与命令）、`index.ts`（scheduler 启停） |
| agent | `supervisor.ts`（bot 扩展、delegate 工具、结果注入）、`tools/memory.ts` |
| preload | `index.ts` 的 `bots` 出口 |
| renderer | `App.tsx` 模式分支、新 `components/bots/*`、`stores/bots/*`、`Sidebar.tsx`、项目列表和 `stores/pairCatalog.ts` 处的过滤 |
| packages | `pair/src/protocol.ts`（新帧与命令）、`phone`（`client.ts`、`sessionCache.ts`、`SessionDrawer.tsx` 加 Bot 分区、新群聊视图） |

## 明确不做

- 外部消息渠道（Telegram / Discord 等）、语音、远程沙箱、图片生成。
- ssh 项目：不能作为 bot 或群的工作区，也不能在 ssh 项目的 Code 会话里拉成员当 coworker。
- 远程节点（桌面连桌面）：不做 Bot 视图；作为 guest 时收到 bot 帧直接忽略，Code 目录里也看不到 bot 项目和会话。
- 成员之间无人触发的自由讨论（必须由人类消息、例行任务或委派触发，并受 maxHops 限制）。
- 迁移 EnsoBot 分支的数据。
- Code 模式的行为变化（除了上面列出的过滤）。

## 测试与验收

- **Red-Green 覆盖的纯函数**：路由（@ 解析、@所有人、群主兜底、跳数与每人次数上限、系统条目不触发、插话分流与队列丢弃、`[skip]`）、增量上下文（cursor、排除自己、40 条截断、格式转义）、委派策略（深度、并发、交集、群成员限制、只投递一次、重启判失败）、群工作区解析（Code 项目 / 独立目录 / 项目被移除）、人物卡 PNG 读写、cron 计算、IPC 入参校验、记忆空间解析。
- **宿主测试**（临时 userData）：spawn / 恢复 / 改绑工作区（私聊与群聊）；投递失败不推进 cursor，skip 或出错仍推进；worker 退出后恢复；时间线 seq 在重启后不回退；删除群时清理独立工作区。
- **真机**：隔离 userData 和 CDP 端口，至少两个厂商的模型，验证私聊、群聊 @ 链、委派和结果回投、默认审批档下的审批与提问、Code 模式拉 bot 当 coworker、例行任务、重启恢复、手机端私聊和群聊（含审批、Web Push、旧版手机忽略新帧）；确认远程节点看不到 bot 项目和会话。
- 提交前运行 `pnpm typecheck && pnpm lint && pnpm test`。按可独立描述的单元拆提交：数据模型与存储 → 会话宿主 → 群聊 → 委派 → 记忆 → 例行任务 → UI → 手机端。

## 已确认决策

上线：放在「设置 → 实验功能」里，默认关闭；开启后侧栏才出现 `Code | Bot` 切换，关闭时 Code 模式零影响（Main 服务不启动调度器，pair 不下发 bot 帧）。


1. 群聊路由：采用「单一回复人 + @ 接力 + 跳数上限」，而不是多人同时回复。
2. 成员默认工作区：私聊默认用 bot 自己的 home 目录，需要时再绑定 Code 项目。
3. 范围包含例行任务和手机端；不考虑 ssh 项目和远程节点。
4. 委派深度 2、并发 3、超时 4h、maxHops 4、maxTurnsPerBot 2 这几个默认值。
5. 新建群聊时选择工作区：基于 Code 项目，或独立工作区。
6. 参考开源实现后的调整（akeru-bot、Z4YT0N/OpenGrokBot）：人类插话在边界丢弃剩余接力并重新路由；支持 `[skip]`；系统条目不触发接力；cursor 在投递成功时推进。
