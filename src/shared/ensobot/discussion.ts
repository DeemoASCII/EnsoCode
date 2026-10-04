import type { EnsobotRoom } from './rooms';

/** 一条人话引出的讨论里，bot 之间最多互相叫醒几次（含主持人收到的汇总提醒）。 */
export const RELAY_LIMIT = 12;
const HISTORY_MAX = 20;
const LINE_MAX = 1_200;
const DUTY_MAX = 80;

export interface DiscussionMember {
  id: string;
  name: string;
  duty: string;
  coordinator: boolean;
}

export interface RelayChain {
  /** 引出讨论的那条人话的 deliveryId。 */
  id: string;
  roomId: string;
  relays: number;
  /** 还没回报主持人的成员；同一个人被叫两次就出现两次。 */
  waiting: string[];
  replies: { cardId: string; text: string }[];
  capped: boolean;
}

export type BriefReason = 'mention' | 'host' | 'relay' | 'report';

export function relayLimitOf(room: Pick<EnsobotRoom, 'relayLimit'> | undefined): number {
  return room?.relayLimit ?? RELAY_LIMIT;
}

function isRelayChain(value: unknown): value is RelayChain {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.roomId === 'string' &&
    typeof item.relays === 'number' &&
    Number.isInteger(item.relays) &&
    item.relays >= 0 &&
    typeof item.capped === 'boolean' &&
    Array.isArray(item.waiting) &&
    item.waiting.every((id) => typeof id === 'string') &&
    Array.isArray(item.replies) &&
    item.replies.every(
      (reply) =>
        !!reply &&
        typeof reply === 'object' &&
        typeof (reply as Record<string, unknown>).cardId === 'string' &&
        typeof (reply as Record<string, unknown>).text === 'string'
    )
  );
}

/** 讨论链落盘的读回：坏的一条跳过，不让其余讨论的接力计数丢掉。 */
export function parseChainDocument(text: string): RelayChain[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRelayChain).map((item) => ({
    id: item.id,
    roomId: item.roomId,
    relays: item.relays,
    waiting: [...item.waiting],
    replies: item.replies.map((reply) => ({ cardId: reply.cardId, text: reply.text })),
    capped: item.capped,
  }));
}

/** 显式主持人仍在群里就用它；否则第一个协调者；否则第一个成员。 */
export function roomHostOf(
  room: Pick<EnsobotRoom, 'memberIds' | 'hostId'>,
  members: readonly { id: string; coordinator: boolean }[]
): string | undefined {
  if (room.hostId && room.memberIds.includes(room.hostId)) return room.hostId;
  const coordinator = room.memberIds.find((id) =>
    members.some((member) => member.id === id && member.coordinator)
  );
  return coordinator ?? room.memberIds[0];
}

/** 人点了名就只叫被点名的人；没点名交给主持人拆解，而不是沉默。 */
export function humanRoomTargets(input: {
  mentions: readonly string[];
  hostId: string | undefined;
}): string[] {
  if (input.mentions.length > 0) return [...input.mentions];
  return input.hostId ? [input.hostId] : [];
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 发给群成员的上下文：群名、成员与职能、主持人、自上次收到消息以来别人说过的话、怎么回复。
 * 返回值以说话人引导语结尾，调用方把原话接在后面。
 */
export function composeRoomBrief(input: {
  roomName: string;
  members: readonly DiscussionMember[];
  selfId: string;
  hostId: string | undefined;
  history: readonly { author: string; text: string }[];
  speaker: string;
  reason: BriefReason;
}): string {
  const roster = input.members.map((member) => {
    const tags = [
      member.id === input.selfId ? '你' : '',
      member.id === input.hostId ? '主持人' : '',
    ].filter(Boolean);
    const duty = clip(oneLine(member.duty.split('\n')[0] ?? ''), DUTY_MAX);
    return `- ${member.name}${tags.length ? `（${tags.join('，')}）` : ''}${duty ? `：${duty}` : ''}`;
  });
  const recent = input.history
    .slice(-HISTORY_MAX)
    .map((line) => `- ${line.author}：${clip(oneLine(line.text), LINE_MAX)}`);
  const isHost = input.selfId === input.hostId;
  const lead: Record<BriefReason, string> = {
    mention: `${input.speaker}在群里点了你：`,
    host: `${input.speaker}在群里说（没有点名，先交给主持人）：`,
    relay: `${input.speaker}在群里点了你：`,
    report: '你分派的成员都回复了。请据此在群里给用户一个清楚的结论；还需要继续分工就再 @ 成员：',
  };
  return [
    `[群聊「${input.roomName}」]`,
    '成员：',
    ...roster,
    ...(recent.length ? ['你上次收到消息之后，群里还说了：', ...recent] : []),
    '',
    '怎么回复：直接写你的回复。这一轮结束时，你最后的回复会以你的名字发到群里。',
    '需要别的成员接手或补充时，在回复里写「@名字 」（名字后面空一格），对方会收到并接着说；不要 @ 自己。',
    isHost
      ? '你是主持人：没点名的消息都会先交给你。先弄清用户要什么，简单的直接回答；需要分工时 @ 合适的成员并说清各自做什么。成员都回复后你会收到汇总提醒，再给用户一个结论。'
      : '只回应和你职能相关的部分，不重复别人已经说过的话；做完了简短说明结果。',
    '',
    lead[input.reason],
    '',
  ].join('\n');
}

/** bot 在群里点名：扣接力次数、记下要回报主持人的人。不叫醒自己和本轮已经叫过的人。 */
export function planRelays(input: {
  chain: RelayChain;
  authorId: string;
  mentions: readonly string[];
  already: readonly string[];
  hostId: string | undefined;
  /** 这条发言属于主持人分派出去的那一支。 */
  reportToHost: boolean;
  limit?: number;
}): { chain: RelayChain; wake: { cardId: string; reportTo?: string }[]; capped: boolean } {
  const limit = input.limit ?? RELAY_LIMIT;
  let relays = input.chain.relays;
  const waiting = [...input.chain.waiting];
  const wake: { cardId: string; reportTo?: string }[] = [];
  let capped = false;
  for (const cardId of input.mentions) {
    if (cardId === input.authorId || input.already.includes(cardId)) continue;
    if (wake.some((item) => item.cardId === cardId)) continue;
    if (relays >= limit) {
      capped = true;
      break;
    }
    relays += 1;
    const reportTo =
      input.reportToHost && input.hostId && cardId !== input.hostId ? input.hostId : undefined;
    if (reportTo) waiting.push(cardId);
    wake.push(reportTo ? { cardId, reportTo } : { cardId });
  }
  return {
    chain: { ...input.chain, relays, waiting, capped: input.chain.capped || capped },
    wake,
    capped: capped && !input.chain.capped,
  };
}

/** 成员这一轮收口：等到分派出去的人都回报了，才给主持人一条汇总提醒。 */
export function settleReport(input: {
  chain: RelayChain;
  cardId: string;
  text: string;
  hostId: string | undefined;
  /** 这一轮的回复已经点名叫醒了主持人：主持人会在群消息里看到它，不再另发汇总。 */
  hostWoken?: boolean;
  limit?: number;
}): { chain: RelayChain; report: { cardId: string; text: string }[] | null; capped: boolean } {
  const index = input.chain.waiting.indexOf(input.cardId);
  if (index < 0) return { chain: input.chain, report: null, capped: false };
  const waiting = [...input.chain.waiting];
  waiting.splice(index, 1);
  const known = input.chain.replies.some(
    (reply) => reply.cardId === input.cardId && reply.text === input.text
  );
  const replies = known
    ? input.chain.replies
    : [...input.chain.replies, { cardId: input.cardId, text: input.text }];
  if (waiting.length > 0 || !input.hostId) {
    return { chain: { ...input.chain, waiting, replies }, report: null, capped: false };
  }
  if (input.hostWoken) {
    return { chain: { ...input.chain, waiting, replies: [] }, report: null, capped: false };
  }
  if (input.chain.relays >= (input.limit ?? RELAY_LIMIT)) {
    return {
      chain: { ...input.chain, waiting, replies: [], capped: true },
      report: null,
      capped: !input.chain.capped,
    };
  }
  return {
    chain: { ...input.chain, waiting, replies: [], relays: input.chain.relays + 1 },
    report: replies,
    capped: false,
  };
}

/** 一轮最后的文字才是回复。工具步骤里的旁白、被中断/出错的半句、已经用气泡说过的，都不再发。 */
export function turnReply(input: {
  text: string;
  stopReason?: string;
  bubbles: readonly string[];
}): string | null {
  const text = input.text.trim();
  if (!text) return null;
  if (
    input.stopReason === 'toolUse' ||
    input.stopReason === 'aborted' ||
    input.stopReason === 'error'
  ) {
    return null;
  }
  if (input.bubbles.some((bubble) => bubble.trim() === text)) return null;
  return text;
}
