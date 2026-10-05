import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalOnboarding } from './GoalOnboarding';

const mocks = vi.hoisted(() => ({
  bots: [
    {
      id: 'bot-1',
      name: 'Ada',
      title: 'Real researcher',
      scope: 'Competitors',
      avatar: { color: '#123456', image: 'portrait.png' },
      persona: 'private',
    },
  ],
  suggestGoal: vi.fn(),
}));
vi.mock('@/stores/bots', () => ({
  useBotsStore: (select: (state: unknown) => unknown) => select({ bots: mocks.bots }),
}));
vi.mock('@/stores/bots/templateLibrary', () => ({ useTeamTemplates: () => [] }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('./BotAbilities', () => ({ suggestErrorText: () => 'Failed' }));
vi.mock('./BotFields', () => ({ AVATAR_PALETTE: ['#999'] }));
vi.mock('./BotAvatar', () => ({
  BotAvatar: ({ bot }: { bot: { name: string; avatar: { image?: string } } }) =>
    createElement('img', { alt: bot.name, src: bot.avatar.image }),
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: ComponentProps<'button'>) =>
    createElement('button', { type: 'button', ...props }, children),
}));
vi.mock('@/components/ui/textarea', () => ({
  Textarea: ({ onChange, ...props }: ComponentProps<'textarea'>) =>
    createElement('textarea', { ...props, onInput: onChange }),
}));

let root: Root;
let container: HTMLElement;
const onPick = vi.fn();
const button = (text: string) => {
  const found = [...container.querySelectorAll('button')].find((el) => el.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
};
const recommend = async () => {
  const input = container.querySelector('textarea');
  await act(async () => {
    if (!input) throw new Error('Missing goal');
    input.value = 'Research competitors';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => button('Recommend').click());
};

describe('GoalOnboarding existing members', () => {
  beforeEach(async () => {
    const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.assign(window, { electronAPI: { bots: { suggestGoal: mocks.suggestGoal } } });
    mocks.suggestGoal.mockResolvedValue({
      ok: true,
      suggestion: {
        kind: 'existing',
        botId: 'bot-1',
        reason: 'Matches',
        firstMessage: 'Please research competitors',
      },
    });
    onPick.mockReset();
    mocks.suggestGoal.mockClear();
    container = window.document.getElementById('root') as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => root.render(createElement(GoalOnboarding, { onPick })));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
  it('sends metadata only, displays the real profile and waits for confirmation', async () => {
    await recommend();
    expect(mocks.suggestGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        members: [{ id: 'bot-1', name: 'Ada', title: 'Real researcher', scope: 'Competitors' }],
      })
    );
    expect(container.textContent).toContain('Real researcher');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('portrait.png');
    expect(onPick).not.toHaveBeenCalled();
    await act(async () => button('Use this member').click());
    expect(onPick).toHaveBeenCalledWith({
      botId: 'bot-1',
      firstMessage: 'Please research competitors',
    });
  });
  it('lets the user choose the original new-member flow instead', async () => {
    await recommend();
    await act(async () => button('Create new instead').click());
    expect(onPick).toHaveBeenCalledWith({ firstMessage: 'Please research competitors' });
  });
  it('keeps the recommendation and edited draft available when opening fails', async () => {
    await recommend();
    await act(async () => {
      const draft = container.querySelector('textarea');
      if (!draft) throw new Error('Missing draft');
      draft.value = 'Edited first message';
      draft.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    onPick.mockRejectedValueOnce(new Error('Failed'));
    await act(async () => button('Use this member').click());
    expect(container.textContent).toContain('Could not open chat. Try again.');
    expect(button('Use this member').disabled).toBe(false);
    expect(onPick).toHaveBeenCalledWith({ botId: 'bot-1', firstMessage: 'Edited first message' });
  });
});
