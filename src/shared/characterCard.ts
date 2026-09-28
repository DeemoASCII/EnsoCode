import { isUuid } from './builtinAgents';

/** 人物卡文件上限。超限拒绝导入，不把坏文件算进列表。 */
export const CHARACTER_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const CHARACTER_IMAGE_MAX_EDGE = 8192;
export const CHARACTER_TEXT_MAX = 8_000;
export const CHARACTER_CARD_SCHEME = 'ensobot-card';

export interface CharacterPersona {
  name: string;
  personality: string;
  setting: string;
}

export interface CharacterRole {
  /** 谁可以呼唤这个人。每人一条，不是整群一个开关。 */
  callableBy: string[];
  toolIds: string[];
  /** 现有审批档。对不上就不当成一种新档。 */
  approvalScope: 'supervised' | 'auto-edits' | 'full' | 'assistant';
  duty: string;
  providerId: string;
  modelId: string;
  concurrency: number;
  /** 只分派、不写公共工作区。 */
  coordinator: boolean;
}

export interface CircleCrop {
  cx: number;
  cy: number;
  r: number;
}

export interface CharacterCardData {
  id: string;
  originId?: string;
  persona: CharacterPersona;
  role: CharacterRole;
  crop: CircleCrop | null;
}

export const EMPTY_PERSONA: CharacterPersona = { name: '', personality: '', setting: '' };

export const EMPTY_ROLE: CharacterRole = {
  callableBy: [],
  toolIds: [],
  approvalScope: 'supervised',
  duty: '',
  providerId: '',
  modelId: '',
  concurrency: 1,
  coordinator: false,
};

export function isCharacterCardId(value: unknown): value is string {
  return isUuid(value);
}

/** 预览地址只含卡 id，不含磁盘路径。 */
export function characterCardPreviewUrl(id: string): string | null {
  if (!isCharacterCardId(id)) return null;
  return `${CHARACTER_CARD_SCHEME}://card/${id}`;
}

export function previewUrlCardId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${CHARACTER_CARD_SCHEME}:` || parsed.hostname !== 'card') return null;
  const id = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  return isCharacterCardId(id) ? id : null;
}

export function cropInsideImage(crop: CircleCrop, width: number, height: number): boolean {
  if (!Number.isFinite(crop.cx) || !Number.isFinite(crop.cy) || !Number.isFinite(crop.r)) {
    return false;
  }
  if (crop.r <= 0) return false;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return false;
  }
  return (
    crop.cx - crop.r >= 0 &&
    crop.cy - crop.r >= 0 &&
    crop.cx + crop.r <= width &&
    crop.cy + crop.r <= height
  );
}

const APPROVAL = new Set(['supervised', 'auto-edits', 'full', 'assistant']);

function text(value: unknown, max = CHARACTER_TEXT_MAX): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > max) return null;
  return trimmed;
}

function stringList(value: unknown, maxItems: number, maxLen: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    const next = text(item, maxLen);
    if (next === null) return null;
    if (next) out.push(next);
  }
  return out;
}

/** 元数据读不出来就返回 null，调用方把图当裸图。 */
export function parseCharacterCardData(
  value: unknown,
  width: number,
  height: number
): CharacterCardData | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (!isCharacterCardId(record.id)) return null;
  const personaRaw = record.persona;
  const roleRaw = record.role;
  if (!personaRaw || typeof personaRaw !== 'object' || !roleRaw || typeof roleRaw !== 'object') {
    return null;
  }
  const personaRec = personaRaw as Record<string, unknown>;
  const roleRec = roleRaw as Record<string, unknown>;
  const name = text(personaRec.name);
  const personality = text(personaRec.personality);
  const setting = text(personaRec.setting);
  const duty = text(roleRec.duty);
  const providerId = text(roleRec.providerId, 128);
  const modelId = text(roleRec.modelId, 128);
  const callableBy = stringList(roleRec.callableBy, 32, 80);
  const toolIds = stringList(roleRec.toolIds, 32, 64);
  if (
    name === null ||
    personality === null ||
    setting === null ||
    duty === null ||
    providerId === null ||
    modelId === null ||
    callableBy === null ||
    toolIds === null
  ) {
    return null;
  }
  const approval = roleRec.approvalScope;
  if (typeof approval !== 'string' || !APPROVAL.has(approval)) return null;
  const concurrency = roleRec.concurrency;
  if (
    typeof concurrency !== 'number' ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32
  ) {
    return null;
  }
  if (typeof roleRec.coordinator !== 'boolean') return null;
  let crop: CircleCrop | null = null;
  if (record.crop !== null && record.crop !== undefined) {
    if (!record.crop || typeof record.crop !== 'object') return null;
    const cropRec = record.crop as Record<string, unknown>;
    const next = { cx: Number(cropRec.cx), cy: Number(cropRec.cy), r: Number(cropRec.r) };
    if (!cropInsideImage(next, width, height)) return null;
    crop = next;
  }
  const origin = record.originId === undefined ? undefined : record.originId;
  if (origin !== undefined && !isCharacterCardId(origin)) return null;
  return {
    id: record.id,
    ...(origin ? { originId: origin } : {}),
    persona: { name, personality, setting },
    role: {
      callableBy,
      toolIds,
      approvalScope: approval as CharacterRole['approvalScope'],
      duty,
      providerId,
      modelId,
      concurrency,
      coordinator: roleRec.coordinator,
    },
    crop,
  };
}

export function characterCardHasContent(
  card: Pick<CharacterCardData, 'persona' | 'role' | 'crop'>
): boolean {
  const persona =
    card.persona.name.length > 0 ||
    card.persona.personality.length > 0 ||
    card.persona.setting.length > 0;
  const role =
    card.role.callableBy.length > 0 ||
    card.role.toolIds.length > 0 ||
    card.role.duty.length > 0 ||
    card.role.providerId.length > 0 ||
    card.role.modelId.length > 0 ||
    card.role.concurrency !== 1 ||
    card.role.coordinator ||
    card.role.approvalScope !== 'supervised';
  return persona || role || card.crop !== null;
}
