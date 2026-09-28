export interface BoardWakeInput {
  text: string;
  /** 被点名的人物卡 id。点了所有人的名字也仍是逐个点名。 */
  mentions: readonly string[];
  knownIds: readonly string[];
  /** 没有这些新事实，被点到的人也不发言。 */
  facts: { taskChanged: boolean; humanAsked: boolean; idle: boolean };
}

export interface BoardWake {
  notify: string[];
  allowSpeech: boolean;
}

/** 没被点名就别叫醒。点名是逐个的，没有一条群发。空内容不产生发言。 */
export function decideBoardWake(input: BoardWakeInput): BoardWake {
  const text = input.text.trim();
  if (!text) return { notify: [], allowSpeech: false };
  const known = new Set(input.knownIds);
  const notify: string[] = [];
  const seen = new Set<string>();
  for (const id of input.mentions) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    notify.push(id);
  }
  const allowSpeech =
    notify.length > 0 && (input.facts.taskChanged || input.facts.humanAsked || input.facts.idle);
  return { notify, allowSpeech };
}

/** 干完可以主动报一句闲。没有新的完成事实就不报。 */
export function idleLine(
  cardId: string,
  completed: boolean
): { cardId: string; text: string } | null {
  if (!cardId || !completed) return null;
  return { cardId, text: '我闲了' };
}
