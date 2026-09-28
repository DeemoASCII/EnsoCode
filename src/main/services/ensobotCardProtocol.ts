import { previewUrlCardId } from '@shared/characterCard';
import { protocol } from 'electron';
import { getCharacterCardStore } from './ensobotRuntime';

/** 预览地址只带卡 id。文件必须落在人物卡目录里。 */
export function registerEnsobotCardProtocol(): void {
  protocol.handle('ensobot-card', (request) => {
    const id = previewUrlCardId(request.url);
    if (!id) return new Response('Bad URL', { status: 400 });
    const read = getCharacterCardStore().readPng(id);
    if (!read.ok) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(read.png), { headers: { 'content-type': 'image/png' } });
  });
}
