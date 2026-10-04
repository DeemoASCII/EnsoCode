import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { byText, type CdpPage } from './cdp';
import { type FakeModel, startFakeModel } from './fakeModel';
import {
  ARTIFACTS,
  type EnsobotApp,
  launchEnsobot,
  type Profile,
  prepareProfile,
  readHostLog,
  removeProfile,
  resetArtifacts,
} from './harness';

/**
 * 像人一样操作 EnsoBot 窗口：点侧栏、在输入框里逐字输入并回车、建群勾人、展开工作记录、
 * 点审批按钮，再对照界面与宿主落盘的日志。模型是本地假模型，行为固定，不花 token。
 */

const GROUP = '方案评审';
const PLAN = '好的，我来分工。@北北 请你先核对一下。';
const CHECKED = '我看过了，没有问题。';
/** 模型原文带 Markdown 粗体；界面上应渲染成粗体，不显示星号。 */
const SUMMARY_SOURCE = '汇总：成员都核对过了，**结论是可以继续**。';
const SUMMARY = '汇总：成员都核对过了，结论是可以继续。';
const MESSAGE = '[data-slot="ensobot-message"]';
const BOT_MESSAGE = '[data-slot="ensobot-message"]:not([data-author="human"])';
const LIVE = '[data-slot="ensobot-live-row"]';

let model: FakeModel;
let profile: Profile;
let app: EnsobotApp;

function page(): CdpPage {
  return app.page;
}

function snapOnFailure(name: string): void {
  onTestFailed(async () => {
    await page()
      .screenshot(path.join(ARTIFACTS, `${name}-failed.png`))
      .catch(() => undefined);
  });
}

async function count(selector: string): Promise<number> {
  return page().evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
}

async function openChat(name: string): Promise<void> {
  await page().click(
    byText('[data-slot="ensobot-conversations"] button', name),
    `侧栏里的 ${name}`
  );
  await page().waitFor(byText('[data-slot="ensobot-chat"] h1', name), `打开 ${name}`);
}

async function send(text: string): Promise<void> {
  const composer = '[data-slot="ensobot-composer"]';
  await page().click(`document.querySelector(${JSON.stringify(composer)})`, '输入框');
  await page().type(text);
  await page().pressEnter();
  await page().waitFor(
    `document.querySelector(${JSON.stringify(composer)})?.value === ''`,
    `发送「${text}」后输入框清空`,
    15_000
  );
}

async function waitBot(text: string, timeoutMs = 90_000): Promise<void> {
  await page().waitFor(byText(BOT_MESSAGE, text), `bot 回复「${text}」`, timeoutMs);
}

beforeAll(async () => {
  resetArtifacts();
  model = await startFakeModel({ delayMs: 600 });
  profile = prepareProfile({
    modelUrl: model.url,
    cards: [
      {
        name: '阿宁',
        duty: '领导：拆解需求并分工',
        rgb: [236, 170, 120],
        role: { coordinator: true },
      },
      {
        name: '北北',
        duty: '数据核对',
        rgb: [120, 170, 236],
        role: { approvalScope: 'supervised' },
      },
      {
        name: '小审',
        duty: '执行命令',
        rgb: [150, 200, 150],
        role: { approvalScope: 'supervised' },
      },
    ],
  });
  app = await launchEnsobot(profile, 'first-run');
});

afterAll(async () => {
  await app?.close();
  await model?.close();
  if (profile) await removeProfile(profile);
});

describe('EnsoBot 前端（模拟真人操作）', () => {
  it('私聊：打字回车后能看到对方在处理，随后出现回复并落盘', async () => {
    snapOnFailure('dm');
    await openChat('北北');
    await send('你好');
    await page().waitFor(byText(`${MESSAGE}[data-author="human"]`, '你好'), '自己的消息上屏');
    await page().waitFor(
      `document.querySelector(${JSON.stringify(LIVE)})`,
      '对方的处理进度',
      60_000
    );
    await waitBot('你好，我是北北。');
    await page().waitFor(`!document.querySelector(${JSON.stringify(LIVE)})`, '进度收起', 20_000);
    expect(
      readHostLog(profile).some(
        (line) => line.kind === 'bubble' && line.text === '你好，我是北北。'
      )
    ).toBe(true);
  });

  it('群聊：不点名交给主持人分工，成员干活可见，主持人最后汇总', async () => {
    snapOnFailure('room');
    await page().click(`document.querySelector('button[aria-label="新建群"]')`, '新建群按钮');
    await page().waitFor(
      `document.querySelector('[role="dialog"] input.ensobot-input')`,
      '建群弹窗'
    );
    await page().click(
      `document.querySelector('[role="dialog"] input.ensobot-input')`,
      '群名输入框'
    );
    await page().type(GROUP);
    await page().click(
      `document.querySelector('[role="dialog"] input[aria-label="阿宁"]')`,
      '勾选阿宁'
    );
    await page().click(
      `document.querySelector('[role="dialog"] input[aria-label="北北"]')`,
      '勾选北北'
    );
    await page().waitFor(
      `document.querySelector('[role="dialog"] [aria-label="主持人"]')?.innerText.includes('阿宁')`,
      '主持人默认是协调者阿宁'
    );
    await page().click(byText('[role="dialog"] button', '建群'), '建群');
    await page().waitFor(byText('[data-slot="ensobot-chat"] h1', GROUP), '进入新群');
    await page().waitFor(byText('[data-slot="ensobot-host-hint"]', '阿宁'), '主持人提示');

    await send('帮我看看这个方案');
    await waitBot(PLAN);
    expect(await count('[data-slot="ensobot-mention"]')).toBeGreaterThan(0);
    await waitBot(CHECKED);
    const checked = byText(BOT_MESSAGE, CHECKED);
    await page().click(
      `${checked}?.querySelector('[data-slot="ensobot-work-log"] button')`,
      '工作记录'
    );
    await page().waitFor(
      `${checked}?.querySelector('[data-slot="ensobot-work-steps"]')?.innerText.includes('ls')`,
      '工作记录里的 ls 步骤'
    );
    await waitBot(SUMMARY);
    await page().waitFor(`!document.querySelector(${JSON.stringify(LIVE)})`, '进度收起', 20_000);
    const summary = byText(BOT_MESSAGE, SUMMARY);
    expect(
      await page().evaluate<string | undefined>(
        `${summary}?.querySelector('[data-slot="ensobot-markdown"] strong')?.innerText`
      )
    ).toBe('结论是可以继续');
    expect(await page().evaluate<string>(`${summary}?.innerText`)).not.toContain('**');
    const preview = await page().evaluate<string>(
      `${byText('[data-slot="ensobot-conversations"] button', GROUP)}?.innerText`
    );
    expect(preview).toContain('结论是可以继续');
    expect(preview).not.toContain('**');

    const shown = await page().evaluate<string[]>(
      `[...document.querySelectorAll(${JSON.stringify(MESSAGE)})].map((el) => el.innerText)`
    );
    const order = [PLAN, CHECKED, SUMMARY].map((text) =>
      shown.findIndex((item) => item.includes(text))
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    await page().screenshot(path.join(ARTIFACTS, 'room.png'));

    const log = readHostLog(profile);
    const room = log.filter((line) => line.kind === 'room');
    expect(room.map((line) => line.text)).toEqual([
      '帮我看看这个方案',
      PLAN,
      CHECKED,
      SUMMARY_SOURCE,
    ]);
    expect(room[0]).toMatchObject({ authorKind: 'human' });
    expect(room[1]).toMatchObject({ authorId: profile.cards.阿宁, authorKind: 'bot' });
    expect(room[2]).toMatchObject({ authorId: profile.cards.北北, authorKind: 'bot' });
    expect(room[2]?.work?.map((step) => `${step.name}:${step.status}`)).toEqual(['ls:done']);
    expect(log.some((line) => line.kind === 'bubble' && line.text === CHECKED)).toBe(false);
  });

  it('审批：需要审批的命令就地出现在成员进度里，点“允许”后继续完成', async () => {
    snapOnFailure('approval');
    await openChat('小审');
    await send('E2E_APPROVAL 请跑一下命令');
    const waiting = `document.querySelector('${LIVE}[data-status="approval"]')`;
    await page().waitFor(waiting, '成员进度显示等待审批', 90_000);
    await page().screenshot(path.join(ARTIFACTS, 'approval.png'));
    // 就地显示时不再重复“小审 · 需要审批”标题，顶部汇总栏也不重复显示这一条。
    expect(await page().evaluate<string>(`${waiting}?.innerText`)).not.toContain('小审 · ');
    expect(await count('section[aria-label="EnsoBot approvals and questions"]')).toBe(0);
    expect(await count('[data-slot="ensobot-retarget"]')).toBe(1);
    await page().click(
      `[...(${waiting}?.querySelectorAll('button') ?? [])].find((el) => el.innerText.trim() === '允许')`,
      '允许按钮'
    );
    await waitBot('命令跑完了');
    const done = await page().evaluate<string>(`${byText(BOT_MESSAGE, '命令跑完了')}?.innerText`);
    expect(done).toContain('E2E_APPROVED');
    const message = byText(BOT_MESSAGE, '命令跑完了');
    await page().click(
      `${message}?.querySelector('[data-slot="ensobot-work-log"] button')`,
      '展开执行记录'
    );
    // 不能只靠模型复述：用户能查看实际参数与工具输出。
    expect(await count('[data-slot="ensobot-work-detail"] summary')).toBeGreaterThan(0);
    await page().click(
      `${message}?.querySelector('[data-slot="ensobot-work-detail"] summary')`,
      '查看工具证据'
    );
    await page().waitFor(
      `${message}?.querySelector('[data-slot="ensobot-work-output"]')?.innerText.includes('E2E_APPROVED')`,
      '分页加载完整工具输出'
    );
    expect(
      await page().evaluate<number>(
        `${message}?.querySelector('[data-slot="ensobot-work-output"]')?.innerText.length`
      )
    ).toBeGreaterThan(20000);
    expect(
      await page().evaluate<string>(
        `${message}?.querySelector('[data-slot="ensobot-work-parameters"]')?.innerText`
      )
    ).toContain('E2E_APPROVED');
    expect(
      await page().evaluate<string>(
        `${message}?.querySelector('[data-slot="ensobot-work-output"]')?.innerText`
      )
    ).toContain('E2E_APPROVED');
    await page().waitFor(
      `!document.querySelector('[data-slot="ensobot-interaction"]')`,
      '审批条收起',
      20_000
    );
    await page().waitFor(
      `!document.querySelector('[data-slot="ensobot-retarget"]')`,
      '对方空闲后不再显示“替换对方正在做的事”',
      20_000
    );
  });

  it('群设置：建群后换主持人、改接力上限，界面和落盘一致', async () => {
    snapOnFailure('room-settings');
    await openChat(GROUP);
    await page().click(`document.querySelector('button[aria-label="群设置"]')`, '群设置按钮');
    const hostSelect = `document.querySelector('[role="dialog"] [aria-label="主持人"]')`;
    await page().waitFor(hostSelect, '群设置弹窗');
    await page().click(hostSelect, '主持人下拉');
    await page().click(byText('[role="option"]', '北北'), '选北北');
    await page().waitFor(`${hostSelect}?.innerText.includes('北北')`, '主持人改成北北');
    await page().click(
      `document.querySelector('[role="dialog"] input[aria-label="接力上限"]')`,
      '接力上限'
    );
    await page().type('3');
    await page().screenshot(path.join(ARTIFACTS, 'room-settings.png'));
    await page().click(byText('[role="dialog"] button', '保存'), '保存');
    await page().waitFor(`!document.querySelector('[role="dialog"]')`, '弹窗关闭');
    await page().waitFor(byText('[data-slot="ensobot-host-hint"]', '北北'), '主持人提示换成北北');
    const groups = JSON.parse(
      readFileSync(path.join(profile.userData, 'ensobot', 'groups.json'), 'utf8')
    ) as { name: string; hostId?: string; relayLimit?: number }[];
    expect(groups.find((item) => item.name === GROUP)).toMatchObject({
      hostId: profile.cards.北北,
      relayLimit: 3,
    });
  });

  it('直接点名的活轮等待审批，群列表也明确显示在等人', async () => {
    snapOnFailure('interrupt-pending');
    await send('@北北 E2E_APPROVAL 只执行这一条命令');
    await page().waitFor(
      `document.querySelector('${LIVE}[data-status="approval"]')`,
      '直接点名等待审批',
      90_000
    );
    expect(
      await page().evaluate<string>(
        `${byText('[data-slot="ensobot-conversations"] button', GROUP)}?.innerText`
      )
    ).toContain('在等你');
  });

  it('重启后：群设置和记录保留，直接点名活轮有中断说明且不重放授权', async () => {
    snapOnFailure('restart');
    await app.close();
    app = await launchEnsobot(profile, 'restart');
    await openChat(GROUP);
    await waitBot(SUMMARY, 30_000);
    await page().waitFor(byText('[data-slot="ensobot-host-hint"]', '北北'), '主持人提示');
    await page().waitFor(byText('[data-slot="ensobot-system-line"]', '中断'), '重启中断说明');
    expect(await count('[data-slot="ensobot-interaction"]')).toBe(0);
    expect(
      readHostLog(profile).filter(
        (line) =>
          line.kind === 'room' && line.authorKind === 'system' && line.text?.includes('中断')
      )
    ).toHaveLength(1);
    expect(model.requests.some((request) => request.prompt.includes('没有点名'))).toBe(true);
  });
});
