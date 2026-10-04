import type { CircleCrop } from '../characterCard';
import type { EnsobotActivity, EnsobotWorkStep } from './activity';
import type { EnsobotInteraction } from './interaction';
import type { EnsobotTask } from './queue';
import type { EnsobotRoom } from './rooms';

/** system：宿主写的说明（失败、没有回复、接力到上限），不是任何人说的话。 */
export type EnsobotAuthorKind = 'human' | 'bot' | 'system';

export interface EnsobotBubble {
  seq: number;
  deliveryId: string;
  cardId: string;
  lane: 'human' | 'bot' | 'background';
  text: string;
  authorKind: EnsobotAuthorKind;
  /** 产出这条回复的那一轮做了什么；旧节点没有。 */
  work?: EnsobotWorkStep[];
}

export interface EnsobotBoardNote {
  seq: number;
  authorId: string;
  authorKind: EnsobotAuthorKind;
  text: string;
  mentions: string[];
  work?: EnsobotWorkStep[];
}

export interface EnsobotWorkspaceView {
  projectId: string | null;
  projectName: string | null;
  sessionId: string | null;
}

export interface EnsobotNotice {
  cardId: string;
  text: string;
}

export interface EnsobotCardFace {
  id: string;
  name: string;
  coordinator: boolean;
  bare: boolean;
  previewUrl: string;
  width: number;
  height: number;
  crop: CircleCrop | null;
}

export interface EnsobotRoomMessage {
  seq: number;
  roomId: string;
  deliveryId: string;
  authorId: string;
  authorKind: EnsobotAuthorKind;
  text: string;
  mentions: string[];
  work?: EnsobotWorkStep[];
}

export interface EnsobotSnapshot {
  seq: number;
  cards: EnsobotCardFace[];
  bubbles: EnsobotBubble[];
  board: EnsobotBoardNote[];
  groups: EnsobotRoom[];
  roomMessages: EnsobotRoomMessage[];
  tasks: EnsobotTask[];
  workspace: EnsobotWorkspaceView;
  notices: EnsobotNotice[];
  /** 可选以兼容旧节点；新宿主始终提供。刷新从 Main 重读，不在 Renderer 存权限状态。 */
  interactions?: EnsobotInteraction[];
  /** 谁正在做什么（排队、思考、调用工具）。可选以兼容旧节点；新宿主始终提供。 */
  activity?: EnsobotActivity[];
}

export interface EnsobotActionResult {
  ok: boolean;
  error?: string;
  disposition?: string;
  roomId?: string;
}

/** 过期的 seq 丢掉。同一条 deliveryId 的气泡只留第一次。 */
export function applyEnsobotSnapshot(
  current: EnsobotSnapshot | null,
  next: EnsobotSnapshot
): EnsobotSnapshot {
  if (current && next.seq <= current.seq) return current;
  const seen = new Set<string>();
  const bubbles: EnsobotBubble[] = [];
  for (const bubble of next.bubbles) {
    if (seen.has(bubble.deliveryId)) continue;
    seen.add(bubble.deliveryId);
    bubbles.push(bubble);
  }
  return { ...next, bubbles };
}
