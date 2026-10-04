import { describe, expect, it } from 'vitest';
import type { ProjectedMessage, ProjectedPart } from '../types/agent';
import {
  replyText,
  stepsFromAssistant,
  stepsFromResult,
  toolSummary,
  WORK_STEPS_MAX,
} from './activity';

describe('ensobot activity', () => {
  it('工具摘要取最有信息的参数，单行且有长度上限', () => {
    expect(toolSummary('read', { path: 'src/a.ts', limit: 20 })).toBe('src/a.ts');
    expect(toolSummary('powershell', { command: 'Get-ChildItem\n  -Recurse' })).toBe(
      'Get-ChildItem -Recurse'
    );
    expect(toolSummary('grep', { pattern: 'TODO', path: 'src' })).toBe('TODO · src');
    expect(toolSummary('mystery', { flag: true })).toBe('');
    expect(toolSummary('read', null)).toBe('');
    expect(toolSummary('bash', { command: 'x'.repeat(500) }).length).toBeLessThanOrEqual(140);
  });

  it('助手消息里的新工具调用变成进行中的步骤；说话工具不算工作步骤', () => {
    const first = stepsFromAssistant(
      [],
      [
        { type: 'text', text: '我先看看' },
        { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.txt' } },
        { type: 'toolCall', id: 't2', name: 'ensobot_say', arguments: { text: '稍等' } },
      ]
    );
    expect(first).toMatchObject([{ id: 't1', name: 'read', summary: 'a.txt', status: 'running' }]);
    expect(first[0]?.parameters).toBe('{\n  "path": "a.txt"\n}');
    const again = stepsFromAssistant(first, [
      { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.txt' } },
    ]);
    expect(again).toBe(first);
    const done = stepsFromResult(first, 't1', false);
    expect(done[0]?.status).toBe('done');
    expect(stepsFromResult(done, 't1', true)[0]?.status).toBe('error');
    expect(stepsFromResult(done, 'missing', false)).toBe(done);
  });

  it('同一工具调用的流式参数补全会刷新摘要和完整参数，不重复增加步骤', () => {
    const first = stepsFromAssistant(
      [],
      [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }]
    );
    const complete = stepsFromAssistant(first, [
      {
        type: 'toolCall',
        id: 't1',
        name: 'read',
        arguments: { path: 'src/a.ts', range: { offset: 2, limit: 20 } },
      },
    ]);
    expect(complete).not.toBe(first);
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({ summary: 'src/a.ts', status: 'running' });
    expect(complete[0]?.parameters).toBe(
      '{\n  "path": "src/a.ts",\n  "range": {\n    "offset": 2,\n    "limit": 20\n  }\n}'
    );
    expect(first[0]).toMatchObject({ summary: '', parameters: '{}' });
  });

  it('摘要相同但参数变化仍更新，同一批次的相同 ID 也归并为最新参数', () => {
    const first = stepsFromAssistant(
      [],
      [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts', limit: 1 } }]
    );
    const next = stepsFromAssistant(first, [
      { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts', limit: 2 } },
      { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts', limit: 3 } },
    ]);
    expect(next).toHaveLength(1);
    expect(next[0]?.summary).toBe('a.ts');
    expect(JSON.parse(next[0]?.parameters ?? 'null')).toEqual({ path: 'a.ts', limit: 3 });
  });

  it('缺参数不生成占位正文，迟到的缺参数消息不擦除已有参数', () => {
    const part: ProjectedPart = { type: 'toolCall', id: 't1', name: 'read' };
    const first = stepsFromAssistant([], [part]);
    expect(first[0]?.parameters).toBeUndefined();
    expect(stepsFromAssistant(first, [part])).toBe(first);
    const complete = stepsFromAssistant(first, [{ ...part, arguments: { path: 'a.ts' } }]);
    expect(complete[0]?.parameters).toBe('{\n  "path": "a.ts"\n}');
    expect(stepsFromAssistant(complete, [part])).toBe(complete);
  });

  it.each([null, {}, [], '', 0, false])('已投影的 JSON 参数 %j 如实序列化', (args) => {
    const steps = stepsFromAssistant(
      [],
      [{ type: 'toolCall', id: 't1', name: 'custom', arguments: args }]
    );
    expect(steps[0]?.parameters).toBe(JSON.stringify(args, null, 2));
  });

  it('只从工具结果文本提取输出并去 ANSI，不带 thinking、图像或消息其它字段', () => {
    const first = stepsFromAssistant([], [{ type: 'toolCall', id: 't1', name: 'bash' }]);
    const message: ProjectedMessage = {
      role: 'toolResult',
      toolCallId: 't1',
      content: [
        { type: 'thinking', text: '不可展示的思考' },
        { type: 'text', text: '\u001b[31m  第一行\u001b[0m\n    缩进\n' },
        { type: 'image', data: 'not-output', mimeType: 'image/png' },
        {
          type: 'text',
          text: '\u001b]8;;https://example.test\u0007链接\u001b]8;;\u001b\\\u001b[2K',
        },
      ],
      errorMessage: '不从此处补输出',
      toolDurationMs: 123,
      duration: 999,
    };
    const done = stepsFromResult(first, 't1', false, message);
    expect(done[0]).toMatchObject({
      status: 'done',
      output: '  第一行\n    缩进\n\n链接',
      durationMs: 123,
    });
    expect(first[0]?.output).toBeUndefined();
  });

  it('参数和输出保留完整投影及其已有截断标记，不另设文本长度上限', () => {
    const text = `${'长文本\n'.repeat(20_000)}\n…`;
    const first = stepsFromAssistant(
      [],
      [{ type: 'toolCall', id: 't1', name: 'write', arguments: { path: 'a.ts', content: text } }]
    );
    expect(JSON.parse(first[0]?.parameters ?? 'null')).toEqual({ path: 'a.ts', content: text });
    const done = stepsFromResult(first, 't1', false, {
      role: 'toolResult',
      toolCallId: 't1',
      content: [{ type: 'text', text }],
    });
    expect(done[0]?.output).toBe(text);
  });

  it('状态相同仍合并更新的输出和耗时，完全相同的投影返回原数组', () => {
    const first = stepsFromAssistant([], [{ type: 'toolCall', id: 't1', name: 'bash' }]);
    const message: ProjectedMessage = {
      role: 'toolResult',
      toolCallId: 't1',
      content: [{ type: 'text', text: '第一版' }],
      toolDurationMs: 0,
    };
    const done = stepsFromResult(first, 't1', false, message);
    expect(done[0]).toMatchObject({ output: '第一版', durationMs: 0 });
    expect(stepsFromResult(done, 't1', false, { ...message })).toBe(done);
    const outputUpdate = { ...message, content: [{ type: 'text' as const, text: '第二版' }] };
    const updated = stepsFromResult(done, 't1', false, outputUpdate);
    expect(updated).not.toBe(done);
    expect(updated[0]).toMatchObject({ status: 'done', output: '第二版', durationMs: 0 });
    const timed = stepsFromResult(updated, 't1', false, { ...outputUpdate, toolDurationMs: 42 });
    expect(timed).not.toBe(updated);
    expect(timed[0]).toMatchObject({ status: 'done', output: '第二版', durationMs: 42 });
    expect(stepsFromResult(timed, 't1', false, { ...outputUpdate, toolDurationMs: 42 })).toBe(
      timed
    );
    expect(stepsFromResult(timed, 'missing', false, message)).toBe(timed);
  });

  it('缺结果或无文本不生成占位输出，也不擦除已知输出与耗时', () => {
    const first = stepsFromAssistant([], [{ type: 'toolCall', id: 't1', name: 'bash' }]);
    const noText: ProjectedMessage = {
      role: 'toolResult',
      toolCallId: 't1',
      content: [{ type: 'thinking', text: '不作为输出' }],
    };
    const done = stepsFromResult(first, 't1', false, noText);
    expect(done[0]?.output).toBeUndefined();
    expect(done[0]?.durationMs).toBeUndefined();
    expect(stepsFromResult(done, 't1', false)).toBe(done);
    const withOutput = stepsFromResult(done, 't1', false, {
      ...noText,
      content: [{ type: 'text', text: '完成' }],
      toolDurationMs: 12,
    });
    expect(withOutput[0]).toMatchObject({ output: '完成', durationMs: 12 });
    expect(stepsFromResult(withOutput, 't1', false, noText)).toBe(withOutput);
    expect(stepsFromResult(withOutput, 't1', false)).toBe(withOutput);
    const emptyOutput = stepsFromResult(withOutput, 't1', false, {
      ...noText,
      content: [{ type: 'text', text: '' }],
    });
    expect(emptyOutput[0]).toMatchObject({ output: '', durationMs: 12 });
  });

  it.each([
    ['User denied this operation', true, 'denied'],
    ['User denied this operation', false, 'done'],
    ['User denied this operation\n', true, 'error'],
    [' User denied this operation', true, 'error'],
    ['User denied this operation: read', true, 'error'],
    ['prefix User denied this operation', true, 'error'],
    ['user denied this operation', true, 'error'],
    ['\u001b[31mUser denied this operation\u001b[0m', true, 'error'],
    ['普通错误', true, 'error'],
  ] as const)('拒绝状态严格匹配文本 %j 与错误标记 %j', (text, isError, status) => {
    const first = stepsFromAssistant([], [{ type: 'toolCall', id: 't1', name: 'bash' }]);
    const result = stepsFromResult(first, 't1', isError, {
      role: 'toolResult',
      toolCallId: 't1',
      content: [{ type: 'text', text }],
    });
    expect(result[0]?.status).toBe(status);
  });

  it.each(['done', 'error', 'denied'] as const)(
    '迟到的 assistant 补参数不覆盖 %s 状态、输出或耗时',
    (status) => {
      const first = stepsFromAssistant([], [{ type: 'toolCall', id: 't1', name: 'read' }]);
      const text = status === 'denied' ? 'User denied this operation' : '工具结果';
      const result = stepsFromResult(first, 't1', status !== 'done', {
        role: 'toolResult',
        toolCallId: 't1',
        content: [{ type: 'text', text }],
        toolDurationMs: 20,
      });
      const parts: ProjectedPart[] = [
        { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } },
      ];
      const complete = stepsFromAssistant(result, parts);
      expect(complete[0]).toMatchObject({
        summary: 'a.ts',
        parameters: '{\n  "path": "a.ts"\n}',
        status,
        output: text,
        durationMs: 20,
      });
      expect(stepsFromAssistant(complete, parts)).toBe(complete);
    }
  );

  it('只读取投影白名单字段，不展开消息或工具调用附带的原始配置', () => {
    const part = {
      type: 'toolCall' as const,
      id: 't1',
      name: 'read',
      arguments: { path: 'a.ts' },
      env: { SECRET: '不要保留' },
      credentials: { token: '不要保留' },
    };
    const first = stepsFromAssistant([], [part]);
    const message = {
      role: 'toolResult',
      toolCallId: 't1',
      content: [{ type: 'text' as const, text: '内容' }],
      env: part.env,
      credentials: part.credentials,
    };
    const done = stepsFromResult(first, 't1', false, message);
    expect(done[0]).toEqual({
      id: 't1',
      name: 'read',
      summary: 'a.ts',
      status: 'done',
      parameters: '{\n  "path": "a.ts"\n}',
      output: '内容',
    });
  });

  it('步骤数量有上限，保留最近的', () => {
    let steps = stepsFromAssistant([], []);
    for (let index = 0; index < WORK_STEPS_MAX + 5; index += 1) {
      steps = stepsFromAssistant(steps, [
        { type: 'toolCall', id: `t${index}`, name: 'ls', arguments: { path: `d${index}` } },
      ]);
    }
    expect(steps).toHaveLength(WORK_STEPS_MAX);
    expect(steps.at(-1)?.summary).toBe(`d${WORK_STEPS_MAX + 4}`);
  });

  it('回复正文只拼文本片段', () => {
    expect(
      replyText([
        { type: 'thinking', text: '想' },
        { type: 'text', text: '第一段' },
        { type: 'toolCall', id: 't', name: 'ls' },
        { type: 'text', text: '第二段' },
      ])
    ).toBe('第一段\n第二段');
  });
});
