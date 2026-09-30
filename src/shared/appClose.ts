export type AppCloseAction = 'cancel' | 'quit' | 'tray';
/** Main 决定关闭工作台还是退出进程；Renderer 只展示对应提示。 */
export type AppCloseScope = 'app' | 'workbench';

export interface AppCloseDecision {
  action: AppCloseAction;
}

export function shouldBypassCloseConfirm(input: {
  allowQuit: boolean;
  quittingForUpdate: boolean;
  bypassDestroy?: boolean;
}): boolean {
  return input.allowQuit || input.quittingForUpdate || input.bypassDestroy === true;
}

export function parseAppCloseResponse(
  requestId: string,
  incomingId: unknown,
  payload: unknown
): AppCloseDecision | null {
  if (typeof incomingId !== 'string' || incomingId !== requestId) return null;
  if (!payload || typeof payload !== 'object') return null;
  const action = (payload as { action?: unknown }).action;
  if (action === 'cancel' || action === 'quit' || action === 'tray') return { action };
  return null;
}
