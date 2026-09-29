import type { CircleCrop } from '../characterCard';
import type { EnsobotInteraction } from './interaction';
import type { EnsobotTask } from './queue';
import type { EnsobotRoom } from './rooms';

export interface EnsobotBubble {
  seq: number;
  deliveryId: string;
  cardId: string;
  lane: 'human' | 'bot' | 'background';
  text: string;
  authorKind: 'human' | 'bot';
}

export interface EnsobotBoardNote {
  seq: number;
  authorId: string;
  authorKind: 'human' | 'bot';
  text: string;
  mentions: string[];
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
  authorKind: 'human' | 'bot';
  text: string;
  mentions: string[];
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
