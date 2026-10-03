import type { DistillPayload } from '../memory/distill';
import { type MemoryAuthority, memorySpaceContext } from '../memory/space';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';

interface MemoryConversation extends MemoryAuthority {
  conversationId: string;
  sessionFile?: string;
}
interface BotMemoryDeps {
  bots: BotStore;
  chats: BotChatStore;
  isCodeProject: (projectId: string) => boolean;
  schedule: (payload: DistillPayload) => Promise<string | undefined>;
}

export class BotMemoryService {
  private pending = new Map<string, Promise<void>>();
  constructor(private readonly deps: BotMemoryDeps) {}

  context(conversation: MemoryAuthority) {
    const bot = conversation.bot;
    const chat = bot?.chatId ? this.deps.chats.get(bot.chatId) : undefined;
    return {
      enabled: !bot || this.deps.bots.get(bot.botId)?.memory.enabled === true,
      context: memorySpaceContext(
        {
          projectId: conversation.projectId,
          ...(bot
            ? { bot: { botId: bot.botId, chatId: chat?.kind === 'group' ? chat.id : null } }
            : {}),
        },
        this.deps.isCodeProject
      ),
    };
  }

  distill(conversation: MemoryConversation): Promise<void> {
    const id = conversation.conversationId;
    const task = (this.pending.get(id) ?? Promise.resolve())
      .then(async () => {
        const { enabled, context } = this.context(conversation);
        if (!enabled || !conversation.sessionFile) return;
        const binding = conversation.bot;
        const chat = binding?.chatId ? this.deps.chats.get(binding.chatId) : undefined;
        const session = binding ? chat?.sessions[binding.botId] : undefined;
        const fromEntryId = session?.conversationId === id ? session.distilledTo : undefined;
        const next = await this.deps.schedule({
          sessionId: id,
          sessionFile: conversation.sessionFile,
          projectId: context.projectId ?? null,
          ...(context.botId ? { botId: context.botId } : {}),
          ...(fromEntryId ? { fromEntryId } : {}),
        });
        if (
          next &&
          chat &&
          binding &&
          this.deps.chats.get(chat.id)?.sessions[binding.botId]?.conversationId === id
        ) {
          this.deps.chats.update(chat.id, (draft) => {
            draft.sessions[binding.botId].distilledTo = next;
            return draft;
          });
        }
      })
      .catch((error) => console.warn('[bots] memory distill failed', error));
    this.pending.set(id, task);
    void task.then(() => {
      if (this.pending.get(id) === task) this.pending.delete(id);
    });
    return task;
  }
}
