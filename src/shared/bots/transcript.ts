import type { BotId, BotProfile, DelegationState, GroupEntry } from '../types/bot';

export type TranscriptMember = Pick<BotProfile, 'id' | 'name' | 'title' | 'scope'>;

/** 面向模型的固定文案，集中放便于本地化 */
export const TRANSCRIPT_LABELS = {
  human: '用户',
  humanRole: '人类',
  system: '系统',
  deleted: '已删除成员',
  omitted: (count: number) => `（省略了 ${count} 条更早的消息）`,
  delegation: (from: string, to: string, state: string) =>
    `「${from}」委派给「${to}」的任务${state}`,
  delegationState: {
    queued: '排队中',
    running: '进行中',
    completed: '已完成',
    failed: '失败',
    canceled: '已取消',
  } satisfies Record<DelegationState, string>,
  intro: (title: string, self: string) => `你在群聊「${title}」中，你是 ${self}。群成员：`,
} as const;

const DEFAULT_LIMIT = 40;

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function message(attrs: { from: string; role?: string; seq: number }, body: string): string {
  const role = attrs.role ? ` role="${escapeXml(attrs.role)}"` : '';
  return `<group-message from="${escapeXml(attrs.from)}"${role} seq="${attrs.seq}">${escapeXml(body)}</group-message>`;
}

function render(entry: GroupEntry, find: (id: BotId) => TranscriptMember | undefined): string {
  const nameOf = (id: BotId) => find(id)?.name ?? TRANSCRIPT_LABELS.deleted;
  switch (entry.kind) {
    case 'human':
      return message(
        { from: TRANSCRIPT_LABELS.human, role: TRANSCRIPT_LABELS.humanRole, seq: entry.seq },
        entry.text
      );
    case 'bot': {
      const member = find(entry.botId);
      return message(
        { from: member?.name ?? TRANSCRIPT_LABELS.deleted, role: member?.title, seq: entry.seq },
        entry.text
      );
    }
    case 'delegation': {
      const head = TRANSCRIPT_LABELS.delegation(
        nameOf(entry.from),
        nameOf(entry.to),
        TRANSCRIPT_LABELS.delegationState[entry.state] ?? entry.state
      );
      const summary = entry.summary?.replace(/\s+/g, ' ').trim();
      return message(
        { from: TRANSCRIPT_LABELS.system, seq: entry.seq },
        summary ? `${head}：${summary}` : head
      );
    }
    default:
      return message({ from: TRANSCRIPT_LABELS.system, seq: entry.seq }, entry.text);
  }
}

function intro(
  chatTitle: string,
  self: TranscriptMember | undefined,
  members: TranscriptMember[]
): string {
  const roster = members.map((m) => {
    const title = m.title ? `（${m.title}）` : '';
    return `- ${m.name}${title}${m.scope ? `：${m.scope}` : ''}`;
  });
  const body = [
    TRANSCRIPT_LABELS.intro(chatTitle, self?.name ?? TRANSCRIPT_LABELS.deleted),
    ...roster,
  ].join('\n');
  return `<group-info>\n${escapeXml(body)}\n</group-info>`;
}

/**
 * 成员轮到发言时的群聊增量：cursor 之后、非本人的条目，超出 limit 只留最后 limit 条。
 * 返回的 cursor 推进到这批的最大 seq（包括本人的条目）；首次（cursor=0）附群简介。
 */
export function buildGroupDelta(input: {
  entries: readonly GroupEntry[];
  botId: BotId;
  cursor: number;
  members: readonly TranscriptMember[];
  chatTitle: string;
  limit?: number;
}): { text: string; cursor: number } {
  const { botId, chatTitle } = input;
  const cursor = Number.isSafeInteger(input.cursor) && input.cursor > 0 ? input.cursor : 0;
  const limit =
    Number.isSafeInteger(input.limit) && (input.limit as number) > 0
      ? (input.limit as number)
      : DEFAULT_LIMIT;
  const members = (Array.isArray(input.members) ? input.members : []).filter(
    (m): m is TranscriptMember =>
      Boolean(m) && typeof m.id === 'string' && typeof m.name === 'string'
  );
  const find = (id: BotId) => members.find((m) => m.id === id);
  const fresh = (Array.isArray(input.entries) ? input.entries : [])
    .filter((e) => e && typeof e === 'object' && Number.isSafeInteger(e.seq) && e.seq > cursor)
    .sort((a, b) => a.seq - b.seq);
  const nextCursor = fresh.at(-1)?.seq ?? cursor;
  const visible = fresh.filter((e) => !(e.kind === 'bot' && e.botId === botId));
  if (visible.length === 0) return { text: '', cursor: nextCursor };
  const omitted = Math.max(0, visible.length - limit);
  const lines = [
    ...(cursor === 0
      ? [intro(typeof chatTitle === 'string' ? chatTitle : '', find(botId), members)]
      : []),
    ...(omitted > 0 ? [TRANSCRIPT_LABELS.omitted(omitted)] : []),
    ...visible.slice(omitted).map((e) => render(e, find)),
  ];
  return { text: lines.join('\n'), cursor: nextCursor };
}
