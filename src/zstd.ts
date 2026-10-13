/**
 * 多帧 Zstandard 的最小读取件（自包含，只用 Node 自带 zlib）。
 *
 * 为什么需要它：DSH 的会话日志是**追加式多帧 zstd**（一个文件几万帧），而 Node 的
 * `zstdDecompressSync` 一次只吃**一帧**——直接喂整个文件只会解出第一行。要读原文，
 * 就得先按 Zstandard 的帧格式把每帧的字节范围扫出来，再逐帧解。
 *
 * 帧格式（RFC 8878）：magic(4) → Frame_Header_Descriptor(1) → [Window_Descriptor]
 * → [Dictionary_ID] → [Frame_Content_Size] → 若干 Block（每个 3 字节头：
 * Last_Block(1) | Block_Type(2) | Block_Size(21)）→ [Content_Checksum(4)]。
 * 扫描**不需要**解压块内容，只要按 Block_Size 跳过——这也是它能这么短的原因。
 *
 * 这与 DSH 自己 `packages/session/session-persistence-jsonl/src/zstd.ts` 的
 * `scanZstdFrames` 做的是同一件事（同一格式），此处按格式重写，不跨项目 import。
 */
import { constants, createZstdDecompress, zstdDecompressSync } from 'node:zlib';
import { readSync } from 'node:fs';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const ZSTD_MAGIC = 0xfd2fb528;

export interface ZstdFrameRange {
  /** 帧起始（含） */
  start: number;
  /** 帧结束（不含） */
  end: number;
}

export interface ZstdFrameScan {
  frames: ZstdFrameRange[];
  /** 文件末尾那半帧的起点；有值表示会话文件正在写 */
  tornStart?: number;
}

/** Inspect only framing headers from the file; block payloads are skipped by byte range. */
export function inspectZstdFrameAt(fd: number, size: number, start: number): ZstdFrameRange | null {
  let offset = start;
  const read = (count: number): Buffer | null => {
    if (offset + count > size) return null;
    const buffer = Buffer.alloc(count);
    if (readSync(fd, buffer, 0, count, offset) !== count) return null;
    offset += count; return buffer;
  };
  const magic = read(4); if (!magic) return null;
  if (magic.readUInt32LE(0) !== ZSTD_MAGIC) throw new Error(`不是合法的 zstd 帧：字节 ${start} 处魔数不对`);
  const descriptorBytes = read(1); if (!descriptorBytes) return null;
  const descriptor = descriptorBytes[0]!;
  if ((descriptor & 0x18) !== 0) throw new Error(`zstd 帧头保留位无效：字节 ${start + 4}`);
  const flag = descriptor >>> 6; const single = (descriptor & 0x20) !== 0; const dictionaryFlag = descriptor & 0x03;
  const headerBytes = (single ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag) + (flag === 0 ? single ? 1 : 0 : 1 << flag);
  if (!read(headerBytes)) return null;
  for (;;) {
    const block = read(3); if (!block) return null;
    const bits = block.readUIntLE(0, 3); const kind = (bits >>> 1) & 3;
    if (kind === 3) throw new Error(`zstd 块类型保留值：字节 ${offset - 3}`);
    const payload = kind === 1 ? 1 : bits >>> 3;
    if (offset + payload > size) return null;
    offset += payload;
    if ((bits & 1) !== 0) break;
  }
  if ((descriptor & 4) !== 0 && !read(4)) return null;
  return { start, end: offset };
}

/** Bounded streaming decoder. The consumer must read to completion to validate the checksum. */
export async function* decodeZstdFrameChunks(fd: number, frame: ZstdFrameRange, onInput?: (chunk: Buffer) => void): AsyncGenerator<Buffer> {
  async function* compressedChunks(): AsyncGenerator<Buffer> {
    let position = frame.start;
    while (position < frame.end) {
      const chunk = Buffer.alloc(Math.min(32 * 1024, frame.end - position));
      const bytes = readSync(fd, chunk, 0, chunk.length, position);
      if (bytes !== chunk.length) throw new Error(`zstd 源帧被截短：字节 ${position}`);
      position += bytes; const data = chunk.subarray(0, bytes); onInput?.(data); yield data;
    }
  }
  // Readable owns no file descriptor. Destroying an early header/processing
  // consumer therefore cannot close the fd shared by both validation passes.
  const input = Readable.from(compressedChunks(), { objectMode: false, highWaterMark: 32 * 1024 });
  const decoder = createZstdDecompress({ chunkSize: 32 * 1024, params: { [constants.ZSTD_d_windowLogMax]: 26 } });
  const onError = (error: Error): void => { decoder.destroy(error); };
  input.on('error', onError);
  input.pipe(decoder);
  try { for await (const chunk of decoder) yield chunk as Buffer; }
  finally {
    input.unpipe(decoder); input.destroy(); decoder.destroy();
    // Wait for Readable.from's async iterator.return/_destroy path before its
    // caller closes the shared fd. Keep the error listener through teardown.
    await Promise.allSettled([finished(input, { cleanup: true }), finished(decoder, { cleanup: true })]);
    input.removeListener('error', onError);
  }
}

/** 扫出一个多帧 zstd 缓冲里所有完整帧的字节范围。
 * `tolerant: true` 时遇到坏字节/保留位当作"到这里为止"，不抛错——读真实会话日志用这个：
 * 尾巴上有一段坏数据不该让整份对话读不出来。默认严格（结构不合法就抛）。 */
export function scanZstdFrames(
  buffer: Buffer,
  maxFrames = Number.POSITIVE_INFINITY,
  opts: { tolerant?: boolean } = {},
): ZstdFrameScan {
  const frames: ZstdFrameRange[] = [];
  const lenient = opts.tolerant === true;
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      if (lenient) return { frames, tornStart: start };
      throw new Error(`不是合法的 zstd 帧：字节 ${offset} 处魔数不对`);
    }
    offset += 4;

    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      if (lenient) return { frames, tornStart: start };
      throw new Error(`zstd 帧头保留了未使用的位（字节 ${offset - 1}）`);
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const restHeader = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < restHeader) return { frames, tornStart: start };
    offset += restHeader;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        if (lenient) return { frames, tornStart: start };
        throw new Error(`zstd 块类型保留值（字节 ${offset - 3}）`);
      }
      // RLE 块的负载固定 1 字节；Raw/Compressed 都是 Block_Size 字节
      const payload = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payload) return { frames, tornStart: start };
      offset += payload;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }

  return { frames };
}

/** 解一帧（传入的必须是 scanZstdFrames 给出的完整帧字节）。 */
export function decompressZstdFrame(frame: Buffer): Buffer {
  return zstdDecompressSync(frame);
}

/** 一步到位：多帧缓冲 → 拼接后的明文。半帧与尾部的坏数据都丢掉（会话文件正在写时很正常）。 */
export function decodeZstdStream(buffer: Buffer): string {
  const { frames } = scanZstdFrames(buffer, Number.POSITIVE_INFINITY, { tolerant: true });
  const parts: Buffer[] = [];
  for (const frame of frames) {
    try {
      parts.push(decompressZstdFrame(buffer.subarray(frame.start, frame.end)));
    } catch {
      // 单帧坏了不该让整份会话读不出来：跳过这一帧，后面的照解
    }
  }
  return Buffer.concat(parts).toString('utf8');
}
