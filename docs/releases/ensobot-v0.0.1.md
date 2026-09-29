# EnsoBot 0.0.1 Preview

EnsoBot 首个独立预览版，与 EnsoCode 共用仓库但不共用安装身份、用户数据或更新通道。

- 私聊、群聊、成员人物卡、留言板与公共工作区。
- 回复按实际投递来源返回，跨聊天面排队，防止串聊。
- 后台任务在整轮成功并通过工具检查后完成；执行中断不会冒充成功或自动重放。
- 重启恢复原会话，worker 崩溃后下一次发送按需恢复。
- 默认全程审批模式可在 EnsoBot 直接允许/拒绝工具、回答模型提问，刷新窗口不会丢失待处理请求；本地与远端节点使用同一校验规则。
- 已合入 EnsoCode 主线截至 `50104c92` 的投递、重试与历史回退修复。

## 安装与数据

- Windows：`EnsoBot-Setup-0.0.1.exe`。
- macOS：EnsoBot `.dmg` / `.zip`（Apple Silicon 与 Intel）。
- Linux：EnsoBot `.AppImage` / `.deb`。
- userData 使用系统 appData 下的 `ensobot`，不会自动读取或迁移 `enso-code` 数据；首次使用请在设置中配置模型。
- 启动后打开 EnsoBot 聊天与配套工作台；项目管理、模型设置与浏览器仍使用现有工作台能力。
- 自动更新仅匹配 `ensobot-v*` 标签与 `ensobot*.yml` 元数据；不会安装 EnsoCode 正式包。本 Release 不设为 Latest。

这是预览版，建议使用独立测试项目；执行中断的任务请检查工作区后重新安排。两台物理节点的互联尚未做专项验收。

资产完整性可用 `SHA256SUMS.txt` 验证。未签名平台可能显示系统安全提示。
