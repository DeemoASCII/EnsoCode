import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { productFor } from '../shared/product';

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('EnsoBot 发布边界', () => {
  it('安装包身份、缓存、版本和更新元数据均与正式版隔离', () => {
    const config = parse(read('electron-builder.ensobot.yml'));
    const version = JSON.parse(read('ensobot-release.json')).version;
    const product = productFor('ensobot');
    expect(config.appId).toBe(product.appId);
    expect(config.productName).toBe(product.name);
    expect(config.extraMetadata.name).toBe(product.slug);
    expect(config.extraMetadata.version).toBe(version);
    expect(config.publish).toHaveLength(1);
    expect(config.publish[0]).toMatchObject({
      provider: 'generic',
      channel: 'ensobot',
      url: `https://github.com/J3n5en/EnsoCode/releases/download/ensobot-v${version}/`,
    });
    expect(config.generateUpdatesFilesForAllChannels).toBe(false);
    expect(parse(read('electron-builder.yml')).appId).toBe('com.j3n5en.enso-code');
    expect(JSON.parse(read('package.json')).version).toBe('0.2.2');
  });
  it('独立工作流以完整门禁和打包成功为前置，仅发布 ensobot 标签为非 Latest 预发布', () => {
    const workflow = parse(read('.github/workflows/ensobot-release.yml'));
    expect(workflow.on.push.tags).toEqual(['ensobot-v*']);
    expect(workflow.jobs.release.needs).toEqual(['package']);
    expect(workflow.jobs.package.needs).toEqual(['verify']);
    expect(workflow.on.workflow_dispatch.inputs.publish.type).toBe('boolean');
    expect(workflow.on.workflow_dispatch.inputs.publish.default).toBe(false);
    const gate = workflow.jobs.verify.steps
      .map((step: { run?: string }) => step.run ?? '')
      .join('\n');
    expect(gate).toContain('pnpm typecheck');
    expect(gate).toContain('pnpm lint');
    expect(gate).toContain('pnpm test');
    expect(gate).toContain('vitest.e2e.config.ts');
    const publish = workflow.jobs.release.steps
      .map((step: { run?: string }) => step.run ?? '')
      .join('\n');
    expect(publish).toContain('--prerelease');
    expect(publish).toContain('--latest=false');
    expect(publish).toContain('--verify-tag');
    expect(publish).toContain('git push origin "refs/tags/$TAG"');
    expect(publish).not.toContain('--force');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 断言 shell 变量留在脚本中，而非 TS 插值。
    expect(publish).toContain('--notes-file "docs/releases/${TAG}.md"');
    const version = JSON.parse(read('ensobot-release.json')).version;
    expect(read(`docs/releases/ensobot-v${version}.md`)).toContain(`EnsoBot ${version}`);
  });
});
