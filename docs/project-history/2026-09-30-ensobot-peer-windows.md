# EnsoBot 与工作台同级窗口

## 行为差距与边界

用户在开发版中发现：关 EnsoCode 工作台时，无论选退出还是进托盘，都会影响 EnsoBot。
问题在 Main 生命周期而不是 Bot UI：`enterServerMode` 主动关闭 Bot，工作台退出则直接 `app.quit()`。

本次仅修改关闭确认的作用域、托盘卸载工作台和确认文案；不拆成两个进程，不修改角色/会话/审批数据，
不变更原左下角入口，也不调整发布或更新通道。

## 修复

- Main 决定 `app` / `workbench` 作用域，经原关闭请求 IPC 传给 UI，不接受 Renderer 自选退出权限。
- EnsoBot 发行版或存在 Bot 窗口时，关工作台只卸载工作台 renderer，明确显示“关闭工作台”。
- 进托盘不关闭同级 Bot；Bot 存在时也保留设置窗和 macOS Dock。
- `destroy()` 不触发 close，因此移除多余的下一次关窗放行标记；恢复工作台后仍需确认。
- 明确的应用退出仍结束整个进程。没有 Bot 的普通 EnsoCode 保持原行为。

长期约定见 [Main 窗口生命周期](../engineering-reference/main/windows.md)。

## 验证

- 新增 `appCloseConfirm.test.ts`、`appServerMode.test.ts` 共 8 项，覆盖作用域、取消、托盘、普通版和明确退出。
- 相关回归 9 文件 / 89 项通过，`pnpm typecheck`、改动文件 Biome 和 `git diff --check` 通过。
- Windows CDP 9888，使用 `temp/ensobot-peer-windows-live/userData` 空模型配置与单独 out 目录：
  点击“关闭工作台”后仅 Bot 保留；恢复工作台后再次点“最小化到托盘”，Bot 仍可见且状态 IPC 可读。
  两次关闭间 Bot 页面的随机标记相同，没有 `worker-exited`，worker PID 30144 保持不变。
- Windows 全量 `pnpm test`：525 文件通过、26 失败、2 跳过；5907 项通过、79 失败、10 跳过。
  失败包含 Windows symlink/EPERM、CRLF、POSIX shell/路径等；本次窗口和 EnsoBot 回归没有失败。
  全仓库 `pnpm lint` 仍为 390 项错误（含 CRLF 格式差异），不能将全量门禁记为通过。
- 一次 background 工具调用空日志即返回，未视作测试完成；上述全量数据来自后续前台完整执行。
- 验证进程和临时 userData/out 已清理，端口 9888 已释放。以上为提交前验证，未推送、未发布。

## 提交后合入主线

- 窗口修复独立提交为 `793dfa38`，随后按用户要求合入 `origin/main` 的 `6c34d34b`，无内容冲突。
- 新增主线内容为下载直连镜像、Hanbao 离线语音和 EnsoCode `0.2.2`；EnsoBot 独立版本仍是 `0.0.1`。
  发布边界测试的 EnsoCode 版本断言由 `0.2.1` 同步到 `0.2.2`，不改 EnsoBot 的身份或更新源。
- 合并后类型检查通过，窗口、EnsoBot、发布隔离、语音与下载相关回归共 208 项通过；
  6 项归档测试按原有 Windows 条件跳过，没有新增跳过规则。
- 完整 Windows 门禁为 5925 项通过、79 失败、11 跳过；失败用例列表与合并前完全相同。
  lint 仍为 390 项错误，未将完整门禁记为通过。日志保留于 `temp/ensobot-main-merge-{tests,lint}.log`。
- 仅保存本地提交，不推送或发布；原 `.gitignore` 本地改动留在工作区。
