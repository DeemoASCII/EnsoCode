import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  type CharacterCardData,
  characterCardPreviewUrl,
  isCharacterCardId,
  parseCharacterCardData,
} from '@shared/characterCard';
import { readCharacterImage, writeCharacterCardPng } from '@shared/characterCardPng';

export interface CardSummary {
  id: string;
  previewUrl: string;
  bare: boolean;
  width: number;
  height: number;
  card: CharacterCardData | null;
}

export interface CardStore {
  list(): { cards: CardSummary[]; errors: { name: string; error: string }[] };
  importBytes(bytes: Uint8Array): { ok: true; cardId: string } | { ok: false; error: string };
  update(id: string, card: unknown): { ok: true; cardId: string } | { ok: false; error: string };
  readPng(id: string): { ok: true; png: Uint8Array; cardId: string } | { ok: false; error: string };
  remove(id: string): { ok: true; cardId: string } | { ok: false; error: string };
  get(id: string): CardSummary | null;
}

function resolveInside(root: string, id: string): string | null {
  if (!isCharacterCardId(id)) return null;
  const dir = path.resolve(root);
  const file = path.resolve(dir, `${id}.png`);
  const relative = path.relative(dir, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  if (path.basename(file) !== `${id}.png`) return null;
  return file;
}

function staysInside(root: string, file: string): boolean {
  try {
    const base = realpathSync(root);
    const target = realpathSync(file);
    const relative = path.relative(base, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

export function createCharacterCardStore(
  root: string,
  options?: {
    uuid?: () => string;
    jpegToPng?: (bytes: Uint8Array) => Uint8Array | null;
  }
): CardStore {
  const uuid = options?.uuid ?? (() => crypto.randomUUID());
  const jpegToPng = options?.jpegToPng ?? defaultJpegToPng;
  mkdirSync(root, { recursive: true });

  const readSafe = (id: string): Uint8Array | null => {
    const file = resolveInside(root, id);
    if (!file) return null;
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) return null;
      if (!staysInside(root, file)) return null;
      return new Uint8Array(readFileSync(file));
    } catch {
      return null;
    }
  };

  const writeSafe = (id: string, bytes: Uint8Array): boolean => {
    const file = resolveInside(root, id);
    if (!file) return false;
    try {
      if (lstatSync(file).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    mkdirSync(root, { recursive: true });
    writeFileSync(file, bytes);
    return staysInside(root, file);
  };

  const summarize = (id: string, bytes: Uint8Array): CardSummary | null => {
    const read = readCharacterImage(bytes);
    if (!read.ok || read.format !== 'png') return null;
    const previewUrl = characterCardPreviewUrl(id);
    if (!previewUrl) return null;
    return {
      id,
      previewUrl,
      bare: read.bare,
      width: read.width,
      height: read.height,
      card: read.card && read.card.id === id ? read.card : read.card ? { ...read.card, id } : null,
    };
  };

  return {
    list() {
      const cards: CardSummary[] = [];
      const errors: { name: string; error: string }[] = [];
      const seen = new Set<string>();
      let names: string[] = [];
      try {
        names = readdirSync(root);
      } catch {
        return { cards, errors: [{ name: path.basename(root), error: 'unreadable' }] };
      }
      for (const name of names) {
        if (!name.endsWith('.png')) continue;
        const id = name.slice(0, -4);
        if (!isCharacterCardId(id)) {
          errors.push({ name, error: 'bad-name' });
          continue;
        }
        if (seen.has(id)) {
          errors.push({ name, error: 'duplicate' });
          continue;
        }
        seen.add(id);
        try {
          const bytes = readSafe(id);
          if (!bytes) {
            errors.push({ name, error: 'rejected' });
            continue;
          }
          const summary = summarize(id, bytes);
          if (!summary) {
            errors.push({ name, error: 'corrupt' });
            continue;
          }
          cards.push(summary);
        } catch {
          errors.push({ name, error: 'corrupt' });
        }
      }
      return { cards, errors };
    },
    importBytes(bytes) {
      const read = readCharacterImage(bytes);
      if (!read.ok) return { ok: false, error: read.error };
      let png: Uint8Array;
      let imported: CharacterCardData | null = null;
      if (read.format === 'jpeg') {
        const converted = jpegToPng(bytes);
        if (!converted) return { ok: false, error: 'jpeg-convert-failed' };
        const again = readCharacterImage(converted);
        if (!again.ok || again.format !== 'png') return { ok: false, error: 'corrupt' };
        png = again.png;
      } else {
        png = read.png;
        imported = read.card;
      }
      const cardId = uuid();
      if (!isCharacterCardId(cardId)) return { ok: false, error: 'bad-id' };
      if (imported) {
        const rewritten = writeCharacterCardPng(png, {
          ...imported,
          id: cardId,
          originId: imported.id,
        });
        if (!rewritten.ok) return { ok: false, error: rewritten.error };
        png = rewritten.png;
      }
      if (!writeSafe(cardId, png)) return { ok: false, error: 'write-failed' };
      return { ok: true, cardId };
    },
    update(id, raw) {
      if (!isCharacterCardId(id)) return { ok: false, error: 'invalid-id' };
      const bytes = readSafe(id);
      if (!bytes) return { ok: false, error: 'not-found' };
      const image = readCharacterImage(bytes);
      if (!image.ok || image.format !== 'png') return { ok: false, error: 'corrupt' };
      const record =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? { ...(raw as Record<string, unknown>), v: 1, id }
          : null;
      const card = parseCharacterCardData(record, image.width, image.height);
      if (!card) return { ok: false, error: 'invalid-card' };
      const written = writeCharacterCardPng(bytes, card);
      if (!written.ok) return { ok: false, error: written.error };
      if (!writeSafe(id, written.png)) return { ok: false, error: 'write-failed' };
      return { ok: true, cardId: id };
    },
    readPng(id) {
      const bytes = readSafe(id);
      if (!bytes) return { ok: false, error: 'not-found' };
      return { ok: true, png: bytes, cardId: id };
    },
    remove(id) {
      const file = resolveInside(root, id);
      if (!file) return { ok: false, error: 'invalid-id' };
      try {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, error: 'rejected' };
        if (!staysInside(root, file)) return { ok: false, error: 'rejected' };
        rmSync(file);
        return { ok: true, cardId: id };
      } catch {
        return { ok: false, error: 'not-found' };
      }
    },
    get(id) {
      const bytes = readSafe(id);
      if (!bytes) return null;
      return summarize(id, bytes);
    },
  };
}

function defaultJpegToPng(bytes: Uint8Array): Uint8Array | null {
  const { nativeImage } = require('electron') as typeof import('electron');
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (size.width < 1 || size.height < 1) return null;
  return new Uint8Array(image.toPNG());
}
