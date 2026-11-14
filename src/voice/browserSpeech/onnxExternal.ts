// An ONNX model with its weights inline loads into ONNX Runtime Web as several whole copies (the
// buffer, the wasm heap, the parsed proto), which ends a phone's tab for Parakeet's 1.25 GB fp16
// encoder. Read in small slices, this writes the graph alone, every initializer pointing at its
// bytes in the original file as external data, so the runtime holds the weights once.
const READ = 64 * 1024;
type Bytes = Uint8Array<ArrayBuffer>;

class SliceReader {
  pos = 0;
  private buffer: Bytes = new Uint8Array(0);
  private start = 0;
  private readonly blob: Blob;
  constructor(blob: Blob) {
    this.blob = blob;
  }

  private async fill(bytes: number) {
    if (this.pos > this.start + this.buffer.length) {
      this.buffer = new Uint8Array(0);
      this.start = this.pos;
    }
    const have = this.start + this.buffer.length - this.pos;
    if (have >= bytes) return;
    const from = this.pos + have;
    const more = new Uint8Array(
      await this.blob.slice(from, from + Math.max(READ, bytes - have)).arrayBuffer(),
    );
    const kept = this.buffer.subarray(this.pos - this.start);
    const next = new Uint8Array(kept.length + more.length);
    next.set(kept);
    next.set(more, kept.length);
    this.buffer = next;
    this.start = this.pos;
    if (next.length < bytes) throw new Error("onnx: file ends early");
  }

  async varint(): Promise<number> {
    await this.fill(Math.min(10, this.blob.size - this.pos));
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = this.buffer[this.pos++ - this.start]!;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
    }
  }

  async bytes(length: number): Promise<Bytes> {
    await this.fill(length);
    const at = this.pos - this.start;
    this.pos += length;
    return this.buffer.slice(at, at + length);
  }

  skip(length: number) {
    this.pos += length;
    if (this.pos > this.blob.size) throw new Error("onnx: file ends early");
  }
}

function varint(value: number): Bytes {
  const out: number[] = [];
  while (value >= 0x80) {
    out.push((value % 128) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return Uint8Array.from(out);
}

const text = new TextEncoder();
const lengthDelimited = (field: number, parts: Bytes[]) => {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  return [varint(field * 8 + 2), varint(length), ...parts];
};
const entry = (key: string, value: string) =>
  lengthDelimited(13, [
    ...lengthDelimited(1, [text.encode(key)]),
    ...lengthDelimited(2, [text.encode(value)]),
  ]);

async function copyField(reader: SliceReader, tag: number): Promise<Bytes[]> {
  const wire = tag % 8;
  if (wire === 0) return [varint(tag), varint(await reader.varint())];
  if (wire === 1) return [varint(tag), await reader.bytes(8)];
  if (wire === 5) return [varint(tag), await reader.bytes(4)];
  if (wire === 2) {
    const length = await reader.varint();
    return [varint(tag), varint(length), await reader.bytes(length)];
  }
  throw new Error(`onnx: unexpected wire type ${wire}`);
}

// TensorProto: raw_data (9) becomes external_data (13) entries and data_location (14) EXTERNAL.
async function tensor(reader: SliceReader, end: number, location: string) {
  const parts: Bytes[] = [];
  let raw: { offset: number; length: number } | null = null;
  while (reader.pos < end) {
    const tag = await reader.varint();
    if (tag === 9 * 8 + 2) {
      const length = await reader.varint();
      raw = { offset: reader.pos, length };
      reader.skip(length);
    } else {
      parts.push(...(await copyField(reader, tag)));
    }
  }
  if (raw !== null) {
    parts.push(
      ...entry("location", location),
      ...entry("offset", String(raw.offset)),
      ...entry("length", String(raw.length)),
      varint(14 * 8),
      varint(1),
    );
  }
  return parts;
}

// GraphProto: initializers (5) are rewritten, the rest (nodes, inputs, outputs) copied. A Blob, as
// its many parts overflow the stack spread into an array (JavaScriptCore).
async function graph(reader: SliceReader, end: number, location: string) {
  const parts: Bytes[] = [];
  while (reader.pos < end) {
    const tag = await reader.varint();
    if (tag === 5 * 8 + 2) {
      const length = await reader.varint();
      parts.push(...lengthDelimited(5, await tensor(reader, reader.pos + length, location)));
    } else {
      parts.push(...(await copyField(reader, tag)));
    }
  }
  return new Blob(parts);
}

/**
 * The graph of `model` (an .onnx with inline weights) with its initializers moved to external data
 * at `location`, which is to be `model` itself, unchanged.
 */
export async function externalGraph(model: Blob, location: string): Promise<Blob> {
  const reader = new SliceReader(model);
  const parts: BlobPart[] = [];
  while (reader.pos < model.size) {
    const tag = await reader.varint();
    if (tag === 7 * 8 + 2) {
      const length = await reader.varint();
      const body = await graph(reader, reader.pos + length, location);
      parts.push(varint(tag), varint(body.size), body);
    } else {
      parts.push(...(await copyField(reader, tag)));
    }
  }
  return new Blob(parts);
}
