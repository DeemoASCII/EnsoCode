import type { ProjectedMessage, ProjectedPart } from '../types/agent';

export const WORK_STEPS_MAX = 24;
const SUMMARY_MAX = 140;
/** 说话工具的内容本身就会出现在聊天里，不再算作工作步骤。 */
const SPEAK_TOOL = 'ensobot_say';

export interface EnsobotWorkStep {
  id: string;
  name: string;
  summary: string;
  status: 'running' | 'done' | 'error' | 'denied';
  /** Main 生成的 opaque ID；正文只能按此 ID 分块读取，不接受文件路径。 */
  evidenceId?: string;
  /** 可选兼容旧宿主；新宿主总是提供。 */
  hasParameters?: boolean;
  hasOutput?: boolean;
  /** worker 的 toolDurationMs，不含排队耗时。 */
  durationMs?: number;
}

/** 仅供 Main 的 runtime/log 使用。不得直接跨 IPC 或 pair 发送。 */
export interface StoredEnsobotWorkStep
  extends Omit<EnsobotWorkStep, 'hasParameters' | 'hasOutput'> {
  /** worker 已投影工具参数的 pretty JSON，不接入原始配置或凭据。 */
  parameters?: string;
  /** 已投影工具结果的可见文本，仅去 ANSI；保留原有截断提示，不再次截断。 */
  output?: string;
}

export type EnsobotActivityState = 'queued' | 'thinking' | 'typing' | 'tool' | 'retrying';

/** 一个成员正在做的事。只在排队或有活轮时出现，收口后消失。 */
export interface EnsobotActivity {
  cardId: string;
  state: EnsobotActivityState;
  surface: 'chat' | 'board' | 'room';
  roomId?: string;
  taskId?: string;
  startedAt?: number;
  /** 还没送进会话的消息条数。 */
  queued: number;
  steps: EnsobotWorkStep[];
}

const SUMMARY_KEYS = [
  'command',
  'pattern',
  'query',
  'path',
  'file_path',
  'url',
  'title',
  'question',
  'description',
  'name',
] as const;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 工具参数的一行摘要：只取人一眼能看懂的字段，不把整段参数塞进界面。 */
export function toolSummary(_name: string, args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const record = args as Record<string, unknown>;
  const values: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) values.push(oneLine(value));
    if (values.length === 2) break;
  }
  const text = values.join(' · ');
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

export function stepsFromAssistant(
  steps: readonly StoredEnsobotWorkStep[],
  parts: readonly ProjectedPart[]
): StoredEnsobotWorkStep[] {
  let next: StoredEnsobotWorkStep[] | null = null;
  for (const part of parts) {
    if (part.type !== 'toolCall' || part.name === SPEAK_TOOL) continue;
    const current: readonly StoredEnsobotWorkStep[] = next ?? steps;
    const index = current.findIndex((step) => step.id === part.id);
    const previous = current[index];
    // arguments 来自 worker 的 JSON 白名单投影；缺字段不是清空已有证据。
    const parameters = JSON.stringify(part.arguments, null, 2);
    const summary =
      parameters === undefined && previous
        ? previous.summary
        : toolSummary(part.name, part.arguments);
    if (previous) {
      const nextParameters = parameters ?? previous.parameters;
      if (previous.summary === summary && previous.parameters === nextParameters) continue;
      next = [...current];
      next[index] = {
        ...previous,
        summary,
        ...(nextParameters !== undefined ? { parameters: nextParameters } : {}),
      };
      continue;
    }
    const step: StoredEnsobotWorkStep = {
      id: part.id,
      name: part.name,
      summary,
      status: 'running',
      ...(parameters !== undefined ? { parameters } : {}),
    };
    next = [...current, step].slice(-WORK_STEPS_MAX);
  }
  return next ?? (steps as StoredEnsobotWorkStep[]);
}

// OSC（含超链接）、CSI（颜色/光标）及短 ESC 序列只影响终端展示，不属于结果正文。
const ANSI_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配 ANSI 控制序列本身。
  /(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|\u009C)|(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|\u001B[ -/]*[@-Z\\-_]/g;

export function stepsFromResult(
  steps: readonly StoredEnsobotWorkStep[],
  toolCallId: string,
  isError: boolean,
  message?: ProjectedMessage
): StoredEnsobotWorkStep[] {
  const index = steps.findIndex((step) => step.id === toolCallId);
  const previous = steps[index];
  if (!previous) return steps as StoredEnsobotWorkStep[];
  const result = message?.role === 'toolResult' ? message : undefined;
  const texts = result?.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
  const text = texts?.length ? texts.join('\n') : undefined;
  // 拒绝只认精确协议文本，不把 trim/ANSI 清洗后的相似错误误标成用户拒绝。
  const status = isError ? (text === 'User denied this operation' ? 'denied' : 'error') : 'done';
  const output = text === undefined ? previous.output : text.replace(ANSI_PATTERN, '');
  const durationMs = result?.toolDurationMs ?? previous.durationMs;
  if (
    previous.status === status &&
    previous.output === output &&
    previous.durationMs === durationMs
  ) {
    return steps as StoredEnsobotWorkStep[];
  }
  return steps.map((step, position) =>
    position === index
      ? {
          ...step,
          status,
          ...(output !== undefined ? { output } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        }
      : step
  );
}

export function replyText(parts: readonly ProjectedPart[]): string {
  return parts
    .flatMap((part) => (part.type === 'text' && part.text.trim() ? [part.text.trim()] : []))
    .join('\n');
}
