import { BOT_NAME_MAX, type BotProfile } from '@shared/types/bot';

export type CharacterCardDraft = Pick<BotProfile, 'name' | 'title' | 'scope'> & { persona: string };
export type CharacterCardResult =
  | { ok: true; draft: CharacterCardDraft }
  | { ok: false; error: 'invalid-json' | 'not-a-card' };

export function sanitizeBotName(raw: string): string {
  const cleaned = raw
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, '_')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return [...cleaned].slice(0, BOT_NAME_MAX).join('');
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function firstSentence(text: string): string {
  const line = text.split('\n').find((item) => item.trim()) ?? '';
  const match = /^.*?[.!?。！？](?=\s|$)/u.exec(line.trim());
  return (match ? match[0] : line.trim()).slice(0, 80);
}

/** SillyTavern 人物卡（V2 的 data / V1 顶层字段）→ 成员草稿；只读文本，不碰路径 */
export function parseCharacterCard(text: string): CharacterCardResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not-a-card' };
  }
  const root = parsed as Record<string, unknown>;
  const data =
    root.data && typeof root.data === 'object' && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root;
  const displayName = str(data.name);
  if (!displayName) return { ok: false, error: 'not-a-card' };
  const fill = (value: string) =>
    value.replace(/\{\{char\}\}/giu, displayName).replace(/\{\{user\}\}/giu, 'the user');
  const description = fill(str(data.description));
  const sections = [
    description,
    str(data.personality) && `Personality: ${fill(str(data.personality))}`,
    str(data.scenario) && `Scenario: ${fill(str(data.scenario))}`,
  ].filter(Boolean);
  return {
    ok: true,
    draft: {
      name: sanitizeBotName(displayName),
      title: '',
      scope: firstSentence(description),
      persona: sections.join('\n\n'),
    },
  };
}
