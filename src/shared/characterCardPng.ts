import { deflateSync, inflateSync } from 'node:zlib';
import {
  CHARACTER_IMAGE_MAX_BYTES,
  CHARACTER_IMAGE_MAX_EDGE,
  type CharacterCardData,
  characterCardHasContent,
  cropInsideImage,
  parseCharacterCardData,
} from './characterCard';

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const KEYWORD = 'ensobot';

export type ImageRead =
  | {
      ok: true;
      format: 'png';
      bare: boolean;
      width: number;
      height: number;
      card: CharacterCardData | null;
      png: Uint8Array;
    }
  | { ok: true; format: 'jpeg'; bare: true }
  | { ok: false; error: 'too-large' | 'corrupt' | 'unsupported' };

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  body.set(new TextEncoder().encode(type), 0);
  body.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return out;
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < SIGNATURE.length) return false;
  return SIGNATURE.every((value, index) => bytes[index] === value);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

interface PngChunk {
  type: string;
  data: Uint8Array;
  raw: Uint8Array;
}

function readChunks(
  bytes: Uint8Array
): { chunks: PngChunk[]; width: number; height: number } | null {
  if (!isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = SIGNATURE.length;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIend = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length) return null;
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expected = view.getUint32(offset + 8 + length);
    const raw = bytes.subarray(offset, offset + 12 + length);
    const critical = type[0] >= 'A' && type[0] <= 'Z';
    const checksum = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (checksum !== expected) {
      if (critical || type === 'IHDR' || type === 'IEND' || type === 'IDAT') return null;
      offset += 12 + length;
      continue;
    }
    if (type === 'IHDR') {
      if (length < 8) return null;
      width = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4);
      if (
        width < 1 ||
        height < 1 ||
        width > CHARACTER_IMAGE_MAX_EDGE ||
        height > CHARACTER_IMAGE_MAX_EDGE
      ) {
        return null;
      }
      sawIhdr = true;
    }
    if (type === 'IEND') sawIend = true;
    chunks.push({ type, data, raw });
    offset += 12 + length;
    if (sawIend) break;
  }
  if (!sawIhdr || !sawIend || offset !== bytes.length) return null;
  return { chunks, width, height };
}

function readEnsotext(data: Uint8Array): string | null {
  const zero = data.indexOf(0);
  if (zero < 1) return null;
  const keyword = new TextDecoder().decode(data.subarray(0, zero));
  if (keyword !== KEYWORD) return null;
  let cursor = zero + 1;
  if (cursor + 2 > data.length) return null;
  const compressed = data[cursor];
  cursor += 2;
  const nextZero = (from: number) => {
    const at = data.indexOf(0, from);
    return at;
  };
  const langEnd = nextZero(cursor);
  if (langEnd < 0) return null;
  const transEnd = nextZero(langEnd + 1);
  if (transEnd < 0) return null;
  const textBytes = data.subarray(transEnd + 1);
  try {
    const decoded = compressed === 1 ? inflateSync(textBytes) : textBytes;
    return new TextDecoder().decode(decoded);
  } catch {
    return null;
  }
}

function encodeMeta(card: CharacterCardData): Uint8Array {
  const json = JSON.stringify({ v: 1, ...card, crop: card.crop });
  const keyword = new TextEncoder().encode(`${KEYWORD}\0`);
  const flags = Uint8Array.of(0, 0);
  const rest = new TextEncoder().encode(`\0\0${json}`);
  return concat([keyword, flags, rest]);
}

/** 一张小的纯色 PNG，测试和 jpg 转码失败时不靠外部图片。 */
export function encodeRgbPng(
  width: number,
  height: number,
  rgb: [number, number, number]
): Uint8Array {
  const row = new Uint8Array(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = new Uint8Array(row.length * height);
  for (let y = 0; y < height; y += 1) raw.set(row, y * row.length);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}

export function readCharacterImage(bytes: Uint8Array): ImageRead {
  if (bytes.byteLength > CHARACTER_IMAGE_MAX_BYTES) return { ok: false, error: 'too-large' };
  if (isJpeg(bytes)) return { ok: true, format: 'jpeg', bare: true };
  if (!isPng(bytes)) return { ok: false, error: 'unsupported' };
  const parsed = readChunks(bytes);
  if (!parsed) return { ok: false, error: 'corrupt' };
  let card: CharacterCardData | null = null;
  let sawMeta = false;
  for (const item of parsed.chunks) {
    if (item.type !== 'iTXt') continue;
    const text = readEnsotext(item.data);
    if (text === null) continue;
    sawMeta = true;
    try {
      card = parseCharacterCardData(JSON.parse(text) as unknown, parsed.width, parsed.height);
    } catch {
      card = null;
    }
    break;
  }
  return {
    ok: true,
    format: 'png',
    bare: !sawMeta || card === null,
    width: parsed.width,
    height: parsed.height,
    card: sawMeta ? card : null,
    png: bytes,
  };
}

export function writeCharacterCardPng(
  png: Uint8Array,
  card: CharacterCardData | null
): { ok: true; png: Uint8Array } | { ok: false; error: 'corrupt' | 'crop-outside' | 'too-large' } {
  const parsed = readChunks(png);
  if (!parsed) return { ok: false, error: 'corrupt' };
  if (card?.crop && !cropInsideImage(card.crop, parsed.width, parsed.height)) {
    return { ok: false, error: 'crop-outside' };
  }
  const kept = parsed.chunks.filter((item) => {
    if (item.type !== 'iTXt') return true;
    return readEnsotext(item.data) === null;
  });
  const meta = card && characterCardHasContent(card) ? chunk('iTXt', encodeMeta(card)) : null;
  const body = concat([
    SIGNATURE,
    ...kept.filter((item) => item.type !== 'IEND').map((item) => item.raw),
    ...(meta ? [meta] : []),
    ...kept.filter((item) => item.type === 'IEND').map((item) => item.raw),
  ]);
  if (body.byteLength > CHARACTER_IMAGE_MAX_BYTES) return { ok: false, error: 'too-large' };
  return { ok: true, png: body };
}

export function idatBytes(png: Uint8Array): Uint8Array | null {
  const parsed = readChunks(png);
  if (!parsed) return null;
  const idat = parsed.chunks.find((item) => item.type === 'IDAT');
  return idat ? idat.data : null;
}
