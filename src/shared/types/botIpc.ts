import type { AttachedImage, ConversationAuthority } from './agent';
import type { BotChat, BotProfile, GroupEntry } from './bot';

/** renderer 可写的成员字段；engine:null = 跟随全局默认模型 */
export type BotDraftInput = Partial<
  Pick<
    BotProfile,
    | 'name'
    | 'title'
    | 'scope'
    | 'avatar'
    | 'approvalMode'
    | 'tools'
    | 'skillIds'
    | 'mcpServerIds'
    | 'delegation'
    | 'memory'
  >
> & { engine?: BotProfile['engine'] | null; persona?: string };

/** renderer 选工作区：chat-home 的项目由 Main 建，不收 projectId */
export type BotChatWorkspaceInput =
  | { kind: 'member-home' }
  | { kind: 'chat-home' }
  | { kind: 'project'; projectId: string };

export interface BotChatCreateInput {
  kind: BotChat['kind'];
  title?: string;
  members: string[];
  bossBotId?: string | null;
  workspace: BotChatWorkspaceInput;
  routing?: Partial<BotChat['routing']>;
}

export interface BotChatUpdateInput {
  chatId: string;
  expectedVersion?: number;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  members?: string[];
  bossBotId?: string | null;
  routing?: Partial<BotChat['routing']>;
  /** 变更后所有成员下次投递开新会话，旧会话只读保留 */
  workspace?: BotChatWorkspaceInput;
}

export type BotEventKind = 'catalog' | 'chat' | 'timeline' | 'queue' | 'delegation' | 'routine';

/** main → renderer：Bot 数据变化提示，renderer 按 kind/chatId 重新拉取 */
export interface BotEvent {
  kind: BotEventKind;
  chatId?: string;
  seq?: number;
}

export type BotIpcError = { ok: false; error: string; reason?: string; chatIds?: string[] };

export interface BotQueueItem {
  chatId: string;
  botId: string;
  conversationId: string;
  /** 0 = 下一个补位 */
  position: number;
}

export interface BotSessionRecord {
  conversationId: string;
  botId: string;
  lifecycle: ConversationAuthority['lifecycle'];
  /** 是否为 chat.sessions 里当前在用的会话；其余为只读历史 */
  current: boolean;
}

export type BotsListResult = { ok: true; bots: BotProfile[]; enabled: boolean } | BotIpcError;
export type BotGetResult = { ok: true; bot: BotProfile; persona: string } | BotIpcError;
export type BotWriteIpcResult = { ok: true; bot: BotProfile } | BotIpcError;
export type BotChatsListResult =
  | { ok: true; chats: BotChat[]; queue: BotQueueItem[]; enabled: boolean }
  | BotIpcError;
export type BotChatWriteResult = { ok: true; chat: BotChat } | BotIpcError;
export type BotTimelineResult = { ok: true; entries: GroupEntry[]; lastSeq: number } | BotIpcError;
export type BotChatSessionsResult = { ok: true; sessions: BotSessionRecord[] } | BotIpcError;
export type BotSendResult =
  | { ok: true; conversationId: string; queued?: boolean; turnId?: string }
  | BotIpcError;
export type BotNewSessionResult = { ok: true; conversationId: string } | BotIpcError;
export type BotActionResult = { ok: true } | BotIpcError;

export interface BotSendRequest {
  chatId: string;
  text: string;
  images?: AttachedImage[];
  deliveryId: string;
}
