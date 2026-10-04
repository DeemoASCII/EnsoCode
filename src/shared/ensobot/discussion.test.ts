import { describe, expect, it } from 'vitest';
import {
  composeRoomBrief,
  humanRoomTargets,
  parseChainDocument,
  planRelays,
  RELAY_LIMIT,
  type RelayChain,
  relayLimitOf,
  roomHostOf,
  settleReport,
  turnReply,
} from './discussion';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '44444444-4444-4444-8444-444444444444';

function chain(patch?: Partial<RelayChain>): RelayChain {
  return { id: 'c1', roomId: 'room', relays: 0, waiting: [], replies: [], capped: false, ...patch };
}

describe('ensobot discussion', () => {
  it('主持人：显式指定的成员优先，否则第一个协调者，否则第一个成员', () => {
    const members = [
      { id: A, coordinator: false },
      { id: B, coordinator: true },
    ];
    expect(roomHostOf({ memberIds: [A, B], hostId: A }, members)).toBe(A);
    expect(roomHostOf({ memberIds: [A, B] }, members)).toBe(B);
    expect(roomHostOf({ memberIds: [A, B], hostId: C }, members)).toBe(B);
    expect(roomHostOf({ memberIds: [A, C] }, members)).toBe(A);
  });

  it('人说话：点了名就只叫被点名的人，没点名交给主持人', () => {
    expect(humanRoomTargets({ mentions: [B], hostId: A })).toEqual([B]);
    expect(humanRoomTargets({ mentions: [], hostId: A })).toEqual([A]);
    expect(humanRoomTargets({ mentions: [], hostId: undefined })).toEqual([]);
  });

  it('群上下文带群名、成员职能、主持人、别人刚说过的话，以及回复方式', () => {
    const brief = composeRoomBrief({
      roomName: '快递单',
      members: [
        { id: A, name: '阿宁', duty: '领导/PM：对齐需求\n第二行不要', coordinator: true },
        { id: B, name: '北北', duty: '写测试', coordinator: false },
      ],
      selfId: B,
      hostId: A,
      history: [{ author: '用户', text: '中通第二页\n只有一个条码' }],
      speaker: '用户',
      reason: 'mention',
    });
    expect(brief).toContain('群聊「快递单」');
    expect(brief).toContain('阿宁（主持人）：领导/PM：对齐需求');
    expect(brief).not.toContain('第二行不要');
    expect(brief).toContain('北北（你）：写测试');
    expect(brief).toContain('用户：中通第二页 只有一个条码');
    expect(brief).toContain('最后的回复会以你的名字发到群里');
    expect(brief).toContain('@名字');
    expect(brief.endsWith('用户在群里点了你：\n')).toBe(true);
    const host = composeRoomBrief({
      roomName: '快递单',
      members: [{ id: A, name: '阿宁', duty: '', coordinator: true }],
      selfId: A,
      hostId: A,
      history: [],
      speaker: '用户',
      reason: 'host',
    });
    expect(host).toContain('阿宁（你，主持人）');
    expect(host).toContain('你是主持人');
    expect(host).not.toContain('群里还说了');
  });

  it('群上下文的历史有条数和单条长度上限', () => {
    const history = Array.from({ length: 40 }, (_, index) => ({
      author: '用户',
      text: `第${index}条${'长'.repeat(3000)}`,
    }));
    const brief = composeRoomBrief({
      roomName: '群',
      members: [],
      selfId: A,
      hostId: undefined,
      history,
      speaker: '用户',
      reason: 'mention',
    });
    expect(brief).not.toContain('第19条');
    expect(brief).toContain('第20条');
    expect(brief).toContain('第39条');
    expect(brief.length).toBeLessThan(40_000);
  });

  it('主持人分派的人要回报；成员之间再点名也回报同一个主持人；不叫醒自己和本轮已叫过的人', () => {
    const planned = planRelays({
      chain: chain(),
      authorId: A,
      mentions: [A, B, C, B],
      already: [],
      hostId: A,
      reportToHost: true,
    });
    expect(planned.wake).toEqual([
      { cardId: B, reportTo: A },
      { cardId: C, reportTo: A },
    ]);
    expect(planned.chain).toMatchObject({ relays: 2, waiting: [B, C] });
    const again = planRelays({
      chain: planned.chain,
      authorId: B,
      mentions: [C, A],
      already: [C],
      hostId: A,
      reportToHost: true,
    });
    expect(again.wake).toEqual([{ cardId: A }]);
    const direct = planRelays({
      chain: chain(),
      authorId: B,
      mentions: [C],
      already: [],
      hostId: A,
      reportToHost: false,
    });
    expect(direct.wake).toEqual([{ cardId: C }]);
    expect(direct.chain.waiting).toEqual([]);
  });

  it('接力用完就停，只在第一次用完时报一次', () => {
    const full = planRelays({
      chain: chain({ relays: RELAY_LIMIT }),
      authorId: A,
      mentions: [B],
      already: [],
      hostId: A,
      reportToHost: true,
    });
    expect(full.wake).toEqual([]);
    expect(full.capped).toBe(true);
    expect(full.chain.capped).toBe(true);
    const later = planRelays({
      chain: full.chain,
      authorId: B,
      mentions: [A],
      already: [],
      hostId: A,
      reportToHost: true,
    });
    expect(later.capped).toBe(false);
    expect(later.wake).toEqual([]);
  });

  it('等所有人回报后才汇总给主持人，汇总本身也占一次接力', () => {
    const first = settleReport({
      chain: chain({ relays: 2, waiting: [B, C] }),
      cardId: B,
      text: '数据没问题',
      hostId: A,
    });
    expect(first.report).toBeNull();
    expect(first.chain.waiting).toEqual([C]);
    const repeated = settleReport({ chain: first.chain, cardId: B, text: '重复', hostId: A });
    expect(repeated.chain).toBe(first.chain);
    const done = settleReport({ chain: first.chain, cardId: C, text: '测试通过', hostId: A });
    expect(done.report).toEqual([
      { cardId: B, text: '数据没问题' },
      { cardId: C, text: '测试通过' },
    ]);
    expect(done.chain).toMatchObject({ waiting: [], replies: [], relays: 3 });
    const capped = settleReport({
      chain: chain({ relays: RELAY_LIMIT, waiting: [B] }),
      cardId: B,
      text: '好了',
      hostId: A,
    });
    expect(capped.report).toBeNull();
    expect(capped.capped).toBe(true);
    const woken = settleReport({
      chain: chain({ relays: 2, waiting: [B] }),
      cardId: B,
      text: '@阿宁 好了',
      hostId: A,
      hostWoken: true,
    });
    expect(woken.report).toBeNull();
    expect(woken.chain).toMatchObject({ waiting: [], replies: [], relays: 2 });
  });

  it('最后的文字才是回复；工具步骤、中断、和已说过的气泡不算', () => {
    expect(turnReply({ text: '  好了  ', stopReason: 'stop', bubbles: [] })).toBe('好了');
    expect(turnReply({ text: '我先看看', stopReason: 'toolUse', bubbles: [] })).toBeNull();
    expect(turnReply({ text: '半句', stopReason: 'aborted', bubbles: [] })).toBeNull();
    expect(turnReply({ text: '出错', stopReason: 'error', bubbles: [] })).toBeNull();
    expect(turnReply({ text: 'OK', stopReason: 'stop', bubbles: [' OK '] })).toBeNull();
    expect(turnReply({ text: '', stopReason: 'stop', bubbles: [] })).toBeNull();
  });

  it('接力上限按群设置，没设就用默认值', () => {
    expect(relayLimitOf({ relayLimit: 3 })).toBe(3);
    expect(relayLimitOf({})).toBe(RELAY_LIMIT);
    expect(relayLimitOf(undefined)).toBe(RELAY_LIMIT);
  });

  it('读回的讨论链坏字段整条丢掉，好的保留', () => {
    expect(
      parseChainDocument(
        JSON.stringify([
          chain({ id: 'ok', relays: 2, waiting: [B], replies: [{ cardId: B, text: '好' }] }),
          { id: 'bad', roomId: 'room', relays: -1, waiting: [], replies: [], capped: false },
          { id: 'bad2', roomId: 'room', relays: 1, waiting: [42], replies: [], capped: false },
          'nope',
        ])
      )
    ).toEqual([chain({ id: 'ok', relays: 2, waiting: [B], replies: [{ cardId: B, text: '好' }] })]);
    expect(parseChainDocument('{')).toEqual([]);
  });
});
