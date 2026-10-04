import type { BotChat, BotProfile } from '@shared/types/bot';
import type { Project } from '@shared/types/project';
import type { TFunction } from '@/i18n';

/** 成员写入失败 reason → 文案 */
export function botErrorText(reason: string | undefined, error: string, t: TFunction): string {
  switch (reason) {
    case 'invalid':
      return t('Names can use up to 24 letters, digits, _ or -, without spaces.');
    case 'reserved':
      return t('This name is reserved. Choose another one.');
    case 'duplicate':
      return t('Another member already uses this name.');
    case 'conflict':
      return t('This member was changed elsewhere. Refresh and try again.');
    case 'not-found':
      return t('This member no longer exists.');
    default:
      return error;
  }
}

export function chatErrorText(error: string, t: TFunction): string {
  switch (error) {
    case 'chat-archived':
      return t('This chat is archived. Restore it before sending.');
    case 'group-not-ready':
    case 'group-unavailable':
      return t('Group chat is not available right now.');
    case 'conflict':
      return t('This chat was changed elsewhere. Refresh and try again.');
    case 'budget-exceeded':
      return t("This member's daily budget is used up. Try again tomorrow or raise the budget.");
    default:
      return error;
  }
}

export function chatTitle(chat: BotChat, bots: readonly BotProfile[], t: TFunction): string {
  if (chat.kind === 'direct') {
    return bots.find((bot) => bot.id === chat.members[0])?.name ?? t('Deleted member');
  }
  return chat.title || t('Untitled group');
}

export function workspaceLabel(
  chat: BotChat,
  projects: readonly Project[],
  bots: readonly BotProfile[],
  t: TFunction
): string {
  switch (chat.workspace.kind) {
    case 'member-home': {
      const name = bots.find((bot) => bot.id === chat.members[0])?.name ?? '';
      return t("{{name}}'s workspace", { name });
    }
    case 'chat-home':
      return t('Group workspace');
    case 'project': {
      const projectId = chat.workspace.projectId;
      const project = projects.find((item) => item.id === projectId);
      return project ? project.alias || project.name : t('Missing project');
    }
  }
}

/** 只有本地项目能当 Bot 工作区 */
export function localProjects(projects: readonly Project[]): Project[] {
  return projects.filter((project) => project.kind !== 'ssh');
}
