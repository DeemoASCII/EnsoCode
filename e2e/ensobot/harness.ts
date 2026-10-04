import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type CharacterRole, EMPTY_ROLE } from '@shared/characterCard';
import { encodeRgbPng } from '@shared/characterCardPng';
import { createCharacterCardStore } from '../../src/main/services/characterCards';
import { CdpPage, listTargets } from './cdp';

/**
 * EnsoBot 前端自动化测试的底座：
 * - 每次都在系统临时目录里建一份隔离的 userData，绝不碰真实配置和会话；
 * - 只配一个指向本地假模型的供应商，人物卡直接写进卡片目录；
 * - 用构建产物启动真实 Electron（EnsoBot 身份），通过 CDP 让 Playwright 像人一样点击、输入。
 */

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const ARTIFACTS = path.join(ROOT, 'temp', 'e2e', 'ensobot');
const PROVIDER_ID = 'pv-e2e';
const MODEL_ID = 'fake-model-1';

export interface SeedCard {
  name: string;
  duty: string;
  rgb: [number, number, number];
  role?: Partial<CharacterRole>;
}

export interface Profile {
  dir: string;
  userData: string;
  cards: Record<string, string>;
}

export function prepareProfile(options: {
  cards: SeedCard[];
  /** 假模型地址；给了 providers 时可以不要。 */
  modelUrl?: string;
  /** 真机验证时换成真实供应商（只写进这份临时 userData）。卡片需在 role 里指明供应商和模型。 */
  providers?: unknown[];
}): Profile {
  const dir = path.join(tmpdir(), `ensobot-e2e-${crypto.randomUUID()}`);
  const userData = path.join(dir, 'userData');
  mkdirSync(userData, { recursive: true });
  const fake = {
    id: PROVIDER_ID,
    name: 'E2E Fake',
    api: 'anthropic-messages',
    apiKey: 'sk-e2e-fake',
    baseUrl: options.modelUrl ?? 'http://127.0.0.1:9',
    enabled: true,
    models: [{ id: MODEL_ID, reasoning: 'off' }],
  };
  const first = options.providers?.[0] as { id?: string; models?: { id?: string }[] } | undefined;
  const state = {
    providers: options.providers ?? [fake],
    defaultModel:
      first?.id && first.models?.[0]?.id
        ? { providerId: first.id, modelId: first.models[0].id }
        : { providerId: PROVIDER_ID, modelId: MODEL_ID },
    onboarded: true,
    language: 'zh',
    theme: 'light',
    autoUpdate: false,
    rtkEnabled: false,
    disabledBuiltinTools: ['subagent', 'workflow'],
  };
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ 'enso-settings': { state, version: 13 } })
  );
  const store = createCharacterCardStore(path.join(userData, 'ensobot-cards'));
  const cards: Record<string, string> = {};
  for (const seed of options.cards) {
    const imported = store.importBytes(encodeRgbPng(64, 64, seed.rgb));
    if (!imported.ok) throw new Error(`seed card failed: ${imported.error}`);
    const updated = store.update(imported.cardId, {
      id: imported.cardId,
      persona: { name: seed.name, personality: '做事认真', setting: '自动化测试里的成员' },
      role: {
        ...EMPTY_ROLE,
        approvalScope: 'full',
        duty: seed.duty,
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        ...seed.role,
      },
      crop: { cx: 32, cy: 32, r: 30 },
    });
    if (!updated.ok) throw new Error(`seed card update failed: ${updated.error}`);
    cards[seed.name] = imported.cardId;
  }
  return { dir, userData, cards };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | null>) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (error) {
      // 进程已经没了，不必等到超时。
      if (error instanceof ExitedError) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out${lastError ? `: ${String(lastError)}` : ''}`);
}

export interface EnsobotApp {
  page: CdpPage;
  logFile: string;
  close(): Promise<void>;
}

export function assertBuilt(): void {
  const main = path.join(ROOT, 'out', 'main', 'index.js');
  const entry = path.join(ROOT, 'out', 'renderer', 'ensobot.html');
  if (!existsSync(main) || !existsSync(entry)) {
    throw new Error(
      '缺少 EnsoBot 构建产物，请先运行 pnpm build:ensobot（或 pnpm test:e2e:ensobot）。'
    );
  }
}

/** 每轮测试前清掉上一轮的截图和日志，免得旧的失败截图混进这一轮的结果。 */
export function resetArtifacts(): void {
  rmSync(ARTIFACTS, { recursive: true, force: true });
  mkdirSync(ARTIFACTS, { recursive: true });
}

/** 结束整棵进程树并等主进程真正退出；否则 Chromium 的单实例锁还占着，下一次启动会立刻退出。 */
async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // 进程已经退出。
    }
  } else {
    child.kill('SIGKILL');
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
}

class ExitedError extends Error {
  constructor(code: number) {
    super(`electron exited ${code}`);
  }
}

export async function launchEnsobot(profile: Profile, label: string): Promise<EnsobotApp> {
  assertBuilt();
  mkdirSync(ARTIFACTS, { recursive: true });
  let lastError: unknown;
  // 刚结束的实例释放单实例锁可能晚一点；拿不到锁的那次会以 0 立即退出，稍等再试。
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await launchOnce(profile, attempt === 1 ? label : `${label}-${attempt}`);
    } catch (error) {
      lastError = error;
      if (!(error instanceof ExitedError) || !error.message.endsWith(' 0')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  throw lastError;
}

async function launchOnce(profile: Profile, label: string): Promise<EnsobotApp> {
  // 应用在开发态会固定开一个 CDP 端口；错开它，免得撞上用户自己开着的实例。
  const port = await freePort();
  const electron = createRequire(import.meta.url)('electron') as unknown as string;
  const logFile = path.join(ARTIFACTS, `${label}.log`);
  const log = createWriteStream(logFile);
  // 不继承 ELECTRON_RUN_AS_NODE / 开发服务器地址：要的是一个真正的窗口进程，加载构建产物。
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== 'ELECTRON_RUN_AS_NODE' && key !== 'ELECTRON_RENDERER_URL'
    )
  );
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    ENSO_USER_DATA_DIR: profile.userData,
    ENSO_CDP_PORT: String(port),
    PI_CODING_AGENT_DIR: path.join(profile.userData, 'agent', 'pi-agent'),
  };
  const child = spawn(
    electron,
    [
      ROOT,
      // 被遮挡的窗口会被 Chromium 当成隐藏并丢掉鼠标事件；测试里保持可见语义。
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  try {
    const target = await waitFor('EnsoBot window', 90_000, async () => {
      if (child.exitCode !== null) throw new ExitedError(child.exitCode);
      const targets = await listTargets(port);
      return (
        targets.find(
          (item) =>
            item.type === 'page' && item.url.includes('ensobot.html') && item.webSocketDebuggerUrl
        ) ?? null
      );
    });
    const page = await CdpPage.connect(target.webSocketDebuggerUrl!);
    await page.waitFor(
      `document.querySelector('[data-slot="ensobot-desk"]')`,
      'EnsoBot 主界面',
      60_000
    );
    return {
      page,
      logFile,
      close: async () => {
        page.close();
        // 不走 app.quit：工作台关窗会先问“关闭工作台还是退出”，自动化里直接结束进程树。
        await killTree(child);
        log.end();
      },
    };
  } catch (error) {
    await killTree(child);
    log.end();
    throw error;
  }
}

/** 主进程结束后，GPU/网络等子进程还会各自收尾一会儿并占着缓存文件；等它们放手再删。 */
export async function removeProfile(profile: Profile): Promise<void> {
  if (process.env.ENSOBOT_E2E_KEEP === '1') return;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      rmSync(profile.dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

export interface LogLine {
  seq: number;
  kind: string;
  roomId?: string;
  authorId?: string;
  authorKind?: string;
  text?: string;
  work?: { name: string; status: string }[];
}

/** 宿主权威日志：界面显示的东西必须能在这里找到，重启后才不会丢。 */
export function readHostLog(profile: Profile): LogLine[] {
  const file = path.join(profile.userData, 'ensobot', 'log.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LogLine);
}
