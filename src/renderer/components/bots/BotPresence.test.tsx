import type { BotProfile, Delegation } from '@shared/types/bot';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemberBusyBar } from './BotPresence';

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('@/stores/bots', () => ({
  useBotsStore: (select: (state: unknown) => unknown) => select(store.state),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      key.replace(/\{\{(\w+)\}\}/g, (token, name: string) => String(params?.[name] ?? token)),
  }),
}));

const bot = (id: string, name: string) => ({ id, name, avatar: { color: '#888' } }) as BotProfile;
const bots = new Map([
  ['b1', bot('b1', 'Jason')],
  ['b2', bot('b2', 'Anran')],
]);
const chat = { id: 'chat1', sessions: { b2: { conversationId: 'c2' } } };
const delegation = {
  id: 'd1',
  chatId: 'chat1',
  parentBotId: 'boss',
  targetBotId: 'b1',
  task: '浏览器标签页锁\n细节',
  childConversationId: 'k1',
  state: 'running',
  createdAt: 1,
} as Delegation;

const render = () =>
  renderToStaticMarkup(
    createElement(MemberBusyBar, {
      chatId: 'chat1',
      memberIds: ['b1', 'b2'],
      bots,
      onOpenLive: () => {},
    })
  );

describe('MemberBusyBar', () => {
  beforeEach(() => {
    store.state = {
      chats: [chat],
      sessions: {},
      queue: [],
      silences: [],
      delegations: [],
      browserHolders: {},
      browserTabs: {},
      timelines: {},
      bots: [],
      browserTitles: {},
    };
  });

  it('全部空闲时不渲染', () => {
    expect(render()).toBe('');
  });

  it('只列非闲成员，委派在跑时附「名字 · 状态 · 短说明」', () => {
    store.state = { ...store.state, delegations: [delegation] };
    const html = render();
    expect(html).toContain('Jason · Planning · 浏览器标签页锁');
    expect(html).not.toContain('Anran');
  });
});
