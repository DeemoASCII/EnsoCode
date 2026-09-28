import { describe, expect, it } from 'vitest';
import { ensobotSteerAction, INTERJECT_TEXT_MAX, planInterjection } from './interject';

describe('ensobot interjection', () => {
  it('活轮包上保留原目标的补充，不另开目标', () => {
    const plan = planInterjection({ text: '把边界也测一下', liveTurn: true, retarget: false });
    expect(plan.action).toBe('steer');
    if (plan.action !== 'steer') return;
    expect(plan.text).toContain('保留原目标');
    expect(plan.text).toContain('把边界也测一下');
    expect(plan.text).toContain('不要单独回一句');
  });

  it('没有活轮就排到下一轮', () => {
    expect(planInterjection({ text: '等下一轮再说', liveTurn: false, retarget: false })).toEqual({
      action: 'queue-next',
      text: '等下一轮再说',
    });
  });

  it('只有明确换目标才标记为换目标', () => {
    expect(planInterjection({ text: '取消这个目标', liveTurn: true, retarget: true })).toEqual({
      action: 'retarget',
      text: '取消这个目标',
    });
  });

  it('空文本和超长文本都不送', () => {
    expect(planInterjection({ text: '   ', liveTurn: true, retarget: false })).toEqual({
      action: 'reject',
      reason: 'empty',
    });
    expect(
      planInterjection({
        text: 'x'.repeat(INTERJECT_TEXT_MAX + 1),
        liveTurn: true,
        retarget: false,
      })
    ).toEqual({ action: 'reject', reason: 'too-long' });
  });

  it('重试倒计时里的插话不打断重试', () => {
    expect(ensobotSteerAction({ running: true, retrying: true })).toBe('defer');
    expect(ensobotSteerAction({ running: true, retrying: false })).toBe('steer');
    expect(ensobotSteerAction({ running: false, retrying: false })).toBe('defer');
  });
});
