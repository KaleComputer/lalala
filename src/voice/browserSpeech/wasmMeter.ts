// Imported first by every speech worker: counts the worker's WASM memory and live WebGPU buffers,
// the memory iOS ends a tab over and that no browser API reports there (no performance.memory).
// The worker tells the page (memoryTrail) whenever the numbers changed, next to a message it sends
// anyway, and as WASM memory is about to grow: no timer, no polling.
type Memory = WebAssembly.Memory;
const memories = new Set<WeakRef<Memory>>();
// Each memory once: it is seen again when exported and at every grow.
const counted = new WeakSet<Memory>();
const keep = (memory: unknown) => {
  if (!(memory instanceof WebAssembly.Memory) || counted.has(memory)) return;
  counted.add(memory);
  memories.add(new WeakRef(memory));
};
const wasmBytes = () => {
  let bytes = 0;
  for (const ref of memories) {
    const memory = ref.deref();
    if (memory === undefined) memories.delete(ref);
    else bytes += memory.buffer.byteLength;
  }
  return bytes;
};

let gpuBytes = 0;
const gpuSizes = new WeakMap<object, number>();

const post = self.postMessage.bind(self) as (message: unknown, transfer?: unknown) => void;
let sent = "";
/** Tells the page the numbers when they moved by a megabyte or more (`growing`: about to grow by). */
const report = (growing = 0) => {
  const wasmMB = Math.round(wasmBytes() / 1e6);
  const gpuMB = Math.round(gpuBytes / 1e6);
  const key = `${wasmMB} ${gpuMB}`;
  if (key === sent && growing === 0) return;
  sent = key;
  post({ type: "meter", wasmMB, gpuMB, ...(growing > 0 ? { growingMB: Math.round(growing / 1e6) } : {}) });
};

try {
  const Original = WebAssembly.Memory;
  WebAssembly.Memory = new Proxy(Original, {
    construct(target, args: [WebAssembly.MemoryDescriptor]) {
      const memory = Reflect.construct(target, args) as Memory;
      keep(memory);
      return memory;
    },
  });
  const grow = Original.prototype.grow;
  Original.prototype.grow = function (this: Memory, pages: number) {
    keep(this);
    report(pages * 65_536);
    return grow.call(this, pages);
  };
  const exported = <T>(result: T): T => {
    const instance = (result as { instance?: WebAssembly.Instance }).instance ?? result;
    if (instance instanceof WebAssembly.Instance)
      for (const value of Object.values(instance.exports)) keep(value);
    return result;
  };
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = ((...args: Parameters<typeof instantiate>) =>
    instantiate(...args).then(exported)) as typeof instantiate;
  const streaming = WebAssembly.instantiateStreaming;
  if (streaming)
    WebAssembly.instantiateStreaming = (...args: Parameters<typeof streaming>) =>
      streaming(...args).then(exported);
  const Device = (globalThis as { GPUDevice?: { prototype: Record<string, unknown> } }).GPUDevice;
  const Buffer = (globalThis as { GPUBuffer?: { prototype: Record<string, unknown> } }).GPUBuffer;
  if (Device && Buffer) {
    const create = Device.prototype.createBuffer as (this: unknown, d: { size: number }) => object;
    Device.prototype.createBuffer = function (this: unknown, descriptor: { size: number }) {
      const buffer = create.call(this, descriptor);
      gpuSizes.set(buffer, descriptor.size);
      gpuBytes += descriptor.size;
      return buffer;
    };
    const destroy = Buffer.prototype.destroy as (this: object) => void;
    Buffer.prototype.destroy = function (this: object) {
      gpuBytes -= gpuSizes.get(this) ?? 0;
      gpuSizes.delete(this);
      return destroy.call(this);
    };
  }
  self.postMessage = ((message: unknown, transfer?: unknown) => {
    post(message, transfer);
    report();
  }) as typeof self.postMessage;
} catch {
  // A browser that won't let these be wrapped: the worker runs as before, uncounted.
}
