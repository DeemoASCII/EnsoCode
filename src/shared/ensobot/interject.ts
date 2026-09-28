export const INTERJECT_TEXT_MAX = 8_000;

const SUPPLEMENT =
  '这是同一件事的补充，保留原目标，写进这一轮的结果里。不要单独回一句「收到」。只有人写明换掉或取消，才换目标。\n补充内容：\n';

export type InterjectPlan =
  | { action: 'reject'; reason: 'empty' | 'too-long' }
  | { action: 'steer'; text: string }
  | { action: 'queue-next'; text: string }
  | { action: 'retarget'; text: string };

/**
 * 活轮则包一层补充说明再绑进去。没有活轮就排到下一轮。
 * 只有调用方明确标了取消或换目标，才换成新目标。不在这里 abort。
 */
export function planInterjection(input: {
  text: string;
  liveTurn: boolean;
  retarget: boolean;
}): InterjectPlan {
  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    return { action: 'reject', reason: 'empty' };
  }
  if (input.text.length > INTERJECT_TEXT_MAX) return { action: 'reject', reason: 'too-long' };
  const text = input.text.trim();
  if (input.retarget) return { action: 'retarget', text };
  if (input.liveTurn) return { action: 'steer', text: `${SUPPLEMENT}${text}` };
  return { action: 'queue-next', text };
}

/** 重试倒计时或没有活轮：插话先排着，不打断重试、不开新轮。 */
export function ensobotSteerAction(input: {
  running: boolean;
  retrying: boolean;
}): 'steer' | 'defer' {
  if (input.retrying || !input.running) return 'defer';
  return 'steer';
}
