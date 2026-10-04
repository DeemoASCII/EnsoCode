import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { parseMentions } from '../../../shared/bots/mentions';
import {
  type HumanEntry,
  isSkipReply,
  mergePending,
  onHumanMessage,
  onReply,
  type RouterState,
  startRound,
} from '../../../shared/bots/router';
import { buildGroupDelta } from '../../../shared/bots/transcript';
import type { BotChat, GroupEntryInput } from '../../../shared/types/bot';
import type {
  BotActionResult,
  BotChatStateResult,
  BotEvent,
  BotSendResult,
} from '../../../shared/types/botIpc';
import type {
  BotDeliverOptions,
  BotDeliverResult,
  BotSessionHost,
  BotTurnFinished,
} from './botSessionHost';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';
import { readJson, writeJsonAtomic } from './files';

interface Round {
  state: RouterState;
  pending: HumanEntry[];
  options?: BotDeliverOptions;
  generation: number;
  stopping?: string;
}
interface AutonomousReply {
  botId: string;
  text: string;
  title: string | undefined;
  options: BotDeliverOptions;
  resolve: (result: BotSendResult) => void;
}
interface GroupChatDeps {
  bots: BotStore;
  chats: BotChatStore;
  host: Pick<BotSessionHost, 'deliver' | 'onTurnFinished' | 'stopTurn' | 'onDeliverySent'>;
  emit: (event: BotEvent) => void;
}
const empty = (): RouterState => ({
  rootEntrySeq: 0,
  current: null,
  queue: [],
  hops: 0,
  turnsByBot: {},
  noticed: [],
});
/** 本轮首个投递之后的接力：deliveryId 与 onlyIfIdle 只属于触发这一轮的那条投递 */
const relayOptions = (options: BotDeliverOptions | undefined): BotDeliverOptions | undefined => {
  if (!options) return options;
  const { deliveryId: _deliveryId, onlyIfIdle: _onlyIfIdle, ...rest } = options;
  return rest;
};

/** 每群串行归并；router.json 只用于崩溃恢复，不重放未完成的工作。 */
export class GroupChatService {
  private rounds = new Map<string, Round>();
  private locks = new Map<string, Promise<unknown>>();
  private autonomous = new Map<string, AutonomousReply[]>();
  private readonly cursors = new Map<string, { chatId: string; botId: string; cursor: number }>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeSent: () => void;
  private disposed = false;

  constructor(private readonly deps: GroupChatDeps) {
    for (const chat of deps.chats.list()) {
      if (chat.kind !== 'group') continue;
      const saved = readJson(this.file(chat.id));
      if (
        saved &&
        typeof saved === 'object' &&
        'state' in saved &&
        saved.state &&
        typeof saved.state === 'object' &&
        'current' in saved.state &&
        saved.state.current
      ) {
        this.system(chat.id, '回复被中断');
      }
      this.persist(chat.id);
    }
    this.unsubscribeSent = deps.host.onDeliverySent((event) => {
      const pending = this.cursors.get(event.deliveryId);
      if (!pending) return;
      this.cursors.delete(event.deliveryId);
      deps.chats.update(pending.chatId, (chat) => {
        const session = chat.sessions[pending.botId];
        if (session?.conversationId === event.conversationId)
          session.cursor = Math.max(session.cursor, pending.cursor);
        return chat;
      });
    });
    this.unsubscribe = deps.host.onTurnFinished((event) => {
      if (event.deliveryId) this.cursors.delete(event.deliveryId);
      if (
        this.disposed ||
        !event.chatId ||
        event.delegationId ||
        !this.rounds.has(event.chatId) ||
        deps.chats.get(event.chatId)?.kind !== 'group'
      )
        return;
      const id = event.chatId;
      const generation = this.round(id).generation;
      void this.lock(id, () => this.finished(event, generation)).catch((error) =>
        console.warn('[bots] group reply failed', error)
      );
    });
  }

  settled(chatId: string): Promise<unknown> {
    return this.locks.get(chatId) ?? Promise.resolve();
  }

  state(chatId: string): BotChatStateResult {
    if (this.deps.chats.get(chatId)?.kind !== 'group')
      return { ok: false, error: 'group-not-found' };
    const { state, pending } = this.round(chatId);
    return {
      ok: true,
      current: state.current,
      queue: [...state.queue],
      hops: state.hops,
      turnsByBot: { ...state.turnsByBot },
      pendingHuman: pending.length > 0,
    };
  }

  send(chatId: string, text: string, options: BotDeliverOptions = {}): Promise<BotSendResult> {
    return this.lock(chatId, async () => {
      if (this.disposed) return { ok: false, error: 'disabled' };
      const chat = this.deps.chats.get(chatId);
      if (chat?.kind !== 'group' || chat.archivedAt !== undefined)
        return { ok: false, error: 'group-unavailable' };
      if (this.round(chatId).stopping) return { ok: false, error: 'chat-stopping' };
      const members = this.members(chat);
      const entry = this.append(chatId, {
        kind: 'human',
        text,
        mentions: parseMentions(text, members).ids,
        id: randomUUID(),
        at: Date.now(),
      });
      if (entry?.kind !== 'human') return { ok: false, error: 'timeline-write-failed' };
      const round = this.round(chatId);
      const decision = onHumanMessage(round.state, chat, members, entry);
      if (decision.action === 'steer') {
        const sent = await this.deliver(chat, round.state.current!, options);
        if (!sent.ok) this.system(chatId, `插话投递失败：${sent.error}`);
      } else if (decision.action === 'restart-after-current') {
        round.pending.push(entry);
        round.options = options;
      } else {
        round.state = decision.state;
        round.options = options;
        if (!round.state.current) this.system(chatId, '请先指定群主');
        await this.dispatch(chatId);
      }
      this.persist(chatId);
      return { ok: true };
    });
  }

  runAs(
    chatId: string,
    botId: string,
    text: string,
    title: string | undefined,
    options: BotDeliverOptions = {}
  ): Promise<BotSendResult> {
    return new Promise((resolve) => {
      void this.lock(chatId, async () => {
        if (this.disposed) {
          resolve({ ok: false, error: 'disabled' });
          return;
        }
        const chat = this.deps.chats.get(chatId);
        if (
          chat?.kind !== 'group' ||
          chat.archivedAt !== undefined ||
          !chat.members.includes(botId)
        ) {
          resolve({ ok: false, error: 'group-unavailable' });
          return;
        }
        const jobs = this.autonomous.get(chatId) ?? [];
        jobs.push({ botId, text, title, options, resolve });
        this.autonomous.set(chatId, jobs);
        if (!this.round(chatId).state.current) await this.dispatch(chatId);
      }).catch((error) => resolve({ ok: false, error: String(error) }));
    });
  }

  stop(chatId: string): Promise<BotActionResult> {
    return this.lock(chatId, async () => {
      if (this.deps.chats.get(chatId)?.kind !== 'group')
        return { ok: false, error: 'group-not-found' };
      const round = this.round(chatId);
      const current = round.state.current ?? round.stopping;
      round.generation++;
      round.state = empty();
      round.pending = [];
      for (const job of this.autonomous.get(chatId) ?? [])
        job.resolve({ ok: false, error: 'chat-stopped' });
      this.autonomous.delete(chatId);
      this.persist(chatId);
      if (current) {
        round.stopping = current;
        try {
          await this.deps.host.stopTurn(chatId, current);
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'stop-failed' };
        }
        delete round.stopping;
      }
      return { ok: true };
    });
  }

  private async finished(event: BotTurnFinished, generation: number): Promise<void> {
    if (this.disposed) return;
    const chat = event.chatId ? this.deps.chats.get(event.chatId) : undefined;
    if (chat?.kind !== 'group') return;
    const round = this.round(chat.id);
    if (
      generation !== round.generation ||
      round.state.current !== event.botId ||
      chat.sessions[event.botId]?.conversationId !== event.conversationId
    )
      return;
    if (!event.ok)
      this.system(
        chat.id,
        `${this.deps.bots.get(event.botId)?.name ?? '已删除成员'} 回复失败：${event.error ?? '未知错误'}`
      );
    else if (!isSkipReply(event.text) && event.turnId)
      this.append(chat.id, {
        kind: 'bot',
        botId: event.botId,
        text: event.text,
        conversationId: event.conversationId,
        turnId: event.turnId,
        id: randomUUID(),
        at: Date.now(),
      });
    this.advance(chat, event.ok ? event.text : '');
    const pending = mergePending(round.pending);
    if (pending) {
      round.pending = [];
      round.state = startRound(chat, this.members(chat), pending);
      if (!round.state.current) this.system(chat.id, '请先指定群主');
    }
    await this.dispatch(chat.id);
    this.persist(chat.id);
  }

  private advance(chat: BotChat, text: string): void {
    const round = this.round(chat.id);
    const result = onReply(round.state, chat, this.members(chat), {
      botId: round.state.current!,
      text,
    });
    round.state = result.state;
    for (const notice of result.notices) this.system(chat.id, notice);
  }

  private async dispatch(chatId: string): Promise<void> {
    if (this.disposed) return;
    const round = this.round(chatId);
    if (!round.state.current) {
      const job = this.autonomous.get(chatId)?.shift();
      if (job) {
        const chat = this.deps.chats.get(chatId);
        const bot = this.deps.bots.get(job.botId);
        if (
          !chat ||
          chat.archivedAt !== undefined ||
          !chat.members.includes(job.botId) ||
          !bot ||
          bot.archivedAt !== undefined
        ) {
          job.resolve({ ok: false, error: 'routine-target-unavailable' });
          return this.dispatch(chatId);
        }
        if (job.title !== undefined) this.system(chatId, `例行任务：${job.title}`);
        round.state = { ...empty(), current: job.botId, turnsByBot: { [job.botId]: 1 } };
        round.options = { ...job.options, queueIfBusy: true };
        round.generation++;
        const sent = await this.deps.host
          .deliver(chatId, job.botId, job.text, round.options)
          .catch((error) => ({ ok: false as const, error: String(error) }));
        job.resolve(sent);
        round.options = relayOptions(round.options);
        if (sent.ok && !sent.duplicate) {
          this.persist(chatId);
          return;
        }
        if (sent.ok) this.system(chatId, `${bot.name} 的投递已处理过，本次未发出`);
        round.state = empty();
        return this.dispatch(chatId);
      }
    }
    let unavailable = false;
    while (round.state.current) {
      const chat = this.deps.chats.get(chatId);
      if (!chat || chat.archivedAt !== undefined) {
        round.state = empty();
        break;
      }
      const botId = round.state.current;
      const bot = this.deps.bots.get(botId);
      if (!bot || bot.archivedAt !== undefined || !chat.members.includes(botId)) {
        unavailable = true;
        this.advance(chat, '');
        continue;
      }
      round.generation++;
      this.persist(chatId);
      const sent = await this.deliver(chat, botId, round.options);
      round.options = relayOptions(round.options);
      if (sent.ok && !sent.duplicate) return;
      this.system(
        chatId,
        sent.ok ? `${bot.name} 的投递已处理过，本次未发出` : `${bot.name} 暂时无法回复`
      );
      this.advance(chat, '');
    }
    if (unavailable) this.system(chatId, '请先指定群主');
    if (this.autonomous.get(chatId)?.length) await this.dispatch(chatId);
  }

  private async deliver(chat: BotChat, botId: string, options?: BotDeliverOptions) {
    const cursor = chat.sessions[botId]?.cursor ?? 0;
    const delta = buildGroupDelta({
      entries: this.deps.chats.readEntries(chat.id, { limit: Number.MAX_SAFE_INTEGER }),
      botId,
      cursor,
      members: this.members(chat),
      chatTitle: chat.title,
    });
    let result: BotDeliverResult;
    const deliveryId = options?.deliveryId ?? randomUUID();
    this.cursors.set(deliveryId, { chatId: chat.id, botId, cursor: delta.cursor });
    try {
      result = await this.deps.host.deliver(chat.id, botId, delta.text, { ...options, deliveryId });
    } catch (error) {
      result = {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // ensureSession 首建会话会设到末尾；失败也要恢复投递前水位。
    this.deps.chats.update(chat.id, (draft) => {
      const session = draft.sessions[botId];
      if (session)
        session.cursor = result.ok && !result.queued && !result.duplicate ? delta.cursor : cursor;
      return draft;
    });
    if (!result.ok || !result.queued) this.cursors.delete(deliveryId);
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribeSent();
    for (const id of this.rounds.keys()) {
      for (const job of this.autonomous.get(id) ?? [])
        job.resolve({ ok: false, error: 'canceled' });
      this.rounds.set(id, { state: empty(), pending: [], generation: 0 });
      this.persist(id);
    }
    this.rounds.clear();
    this.autonomous.clear();
    this.cursors.clear();
  }

  discard(chatId: string): void {
    for (const job of this.autonomous.get(chatId) ?? [])
      job.resolve({ ok: false, error: 'canceled' });
    this.autonomous.delete(chatId);
    this.rounds.delete(chatId);
    for (const [id, cursor] of this.cursors) if (cursor.chatId === chatId) this.cursors.delete(id);
  }

  private members(chat: BotChat) {
    return chat.members.flatMap((id) => {
      const bot = this.deps.bots.get(id);
      return bot ? [bot] : [];
    });
  }
  private round(id: string): Round {
    let round = this.rounds.get(id);
    if (!round) {
      round = { state: empty(), pending: [], generation: 0 };
      this.rounds.set(id, round);
    }
    return round;
  }
  private file(id: string) {
    return join(dirname(this.deps.chats.workspaceDir(id)), 'router.json');
  }
  private persist(id: string): void {
    if (!this.deps.chats.get(id)) return;
    const { state, pending } = this.round(id);
    writeJsonAtomic(this.file(id), { version: 1, state, pending });
    this.deps.emit({ kind: 'chat', chatId: id });
  }
  private append(id: string, entry: GroupEntryInput) {
    const saved = this.deps.chats.appendEntry(id, entry);
    if (saved) this.deps.emit({ kind: 'timeline', chatId: id, seq: saved.seq });
    return saved;
  }
  private system(id: string, text: string): void {
    this.append(id, { kind: 'system', id: randomUUID(), at: Date.now(), text });
  }
  private lock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).then(task, task);
    const settled = run.catch(() => {});
    this.locks.set(id, settled);
    void settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    });
    return run;
  }
}
