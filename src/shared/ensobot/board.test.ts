import { describe, expect, it } from 'vitest';
import { decideBoardWake, idleLine } from './board';

const known = ['a', 'b', 'c'];

describe('ensobot board wake', () => {
  it('没点名就谁也不叫醒', () => {
    expect(
      decideBoardWake({
        text: '这块做完了',
        mentions: [],
        knownIds: known,
        facts: { taskChanged: true, humanAsked: false, idle: false },
      })
    ).toEqual({ notify: [], allowSpeech: false });
  });

  it('点了一个人，没有新事实就只通知、不发言', () => {
    expect(
      decideBoardWake({
        text: '在吗',
        mentions: ['b'],
        knownIds: known,
        facts: { taskChanged: false, humanAsked: false, idle: false },
      })
    ).toEqual({ notify: ['b'], allowSpeech: false });
  });

  it('点了所有人的名字仍是逐个点名，人问了新问题才允许发言', () => {
    expect(
      decideBoardWake({
        text: '大家都看一下',
        mentions: ['a', 'b', 'c', 'a'],
        knownIds: known,
        facts: { taskChanged: false, humanAsked: true, idle: false },
      })
    ).toEqual({ notify: ['a', 'b', 'c'], allowSpeech: true });
  });

  it('空内容不产生发言', () => {
    expect(
      decideBoardWake({
        text: '  ',
        mentions: ['a', 'b'],
        knownIds: known,
        facts: { taskChanged: true, humanAsked: true, idle: true },
      })
    ).toEqual({ notify: [], allowSpeech: false });
  });

  it('没做完不报闲', () => {
    expect(idleLine('a', false)).toBeNull();
    expect(idleLine('a', true)).toEqual({ cardId: 'a', text: '我闲了' });
  });
});
