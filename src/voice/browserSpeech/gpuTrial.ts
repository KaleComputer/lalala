// WebGPU first on every device, without letting one crash repeat (Tim, 16 Nov). A WebGPU run that
// takes the tab down (iOS ended Tim's iPhone tab on 15 and 16 Nov) can't be caught, so a marker goes
// into storage right before WebGPU starts and comes out once the first real sentence was spoken. A
// page that finds the marker still there knows the last try died: this device stays on the CPU until
// reset. Self-contained (no lalala imports), so the release demo can use the same file.

export type GpuTrial = {
  /** WebGPU may be tried on this device (no earlier try died here). */
  allowed(): boolean;
  /** Right before WebGPU starts. */
  begin(): void;
  /** The first real synthesis worked, or the model ended up on the CPU anyway: the try is over. */
  passed(): void;
  /** The device was put on the CPU by a crash: try WebGPU again on the next start. */
  reset(): void;
  /** Whether a crash put this device on the CPU (for Settings). */
  benched(): boolean;
};

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // No storage (a private window): WebGPU is tried every time, as without this.
  }
};

/**
 * prefix names the two keys (`<prefix>:webgpu-trial`, `<prefix>:webgpu-off`). onCrash hears about a
 * try that died, once, when the next page finds its marker.
 */
export function gpuTrial(prefix: string, onCrash?: (since: string) => void): GpuTrial {
  const TRIAL = `${prefix}:webgpu-trial`;
  const OFF = `${prefix}:webgpu-off`;
  const page = Math.random().toString(36).slice(2, 10);
  const lock = (id: string) => `${prefix}:webgpu-page:${id}`;
  let mine = false;

  // The marker names its page, which holds a Web Lock for its life: another open tab still trying
  // is no crash, since the browser frees a page's locks only when the page is gone.
  const left = read(TRIAL);
  if (left !== null) {
    const [id, since] = left.split(" ");
    void (navigator.locks?.query() ?? Promise.resolve({ held: [] as { name?: string }[] }))
      .then(({ held }) => {
        if (held?.some((entry) => entry.name === lock(id ?? ""))) return;
        if (read(TRIAL) !== left) return;
        write(TRIAL, null);
        write(OFF, since ?? new Date().toISOString());
        onCrash?.(since ?? "");
      })
      .catch(() => {});
  }
  let startedAt = "";
  const lift = () => {
    if (read(TRIAL)?.startsWith(`${page} `)) write(TRIAL, null);
  };
  // A reload or leaving is no crash: the marker goes with the page.
  const end = () => {
    if (mine) lift();
    mine = false;
  };
  window.addEventListener("pagehide", end);
  // iOS ends tabs in the background without a pagehide: hidden, the try steps aside, and it is
  // marked again when the page is back in front.
  document.addEventListener("visibilitychange", () => {
    if (!mine) return;
    if (document.visibilityState === "hidden") lift();
    else write(TRIAL, `${page} ${startedAt}`);
  });

  return {
    allowed: () => read(OFF) === null && (left === null || read(TRIAL) !== left),
    begin() {
      mine = true;
      startedAt = new Date().toISOString();
      if (document.visibilityState !== "hidden") write(TRIAL, `${page} ${startedAt}`);
      void navigator.locks?.request(lock(page), () => new Promise<never>(() => {}));
    },
    passed: end,
    reset() {
      write(OFF, null);
      write(TRIAL, null);
    },
    benched: () => read(OFF) !== null,
  };
}

/**
 * What the device offers before a model is tried on it: navigator.gpu, an adapter, and a device that
 * opens. The model's own warm-up sentence is the test run after this.
 */
export async function webGpuWorks(): Promise<boolean> {
  type Adapter = { requestDevice(): Promise<{ destroy?(): void }> };
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<Adapter | null> } }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return false;
    const device = await adapter.requestDevice();
    device.destroy?.();
    return true;
  } catch {
    return false;
  }
}
