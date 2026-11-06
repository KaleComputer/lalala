// The app's code (../src/voice) is built by Vite; under Next its HMR hooks are simply absent.
interface ImportMeta {
  readonly hot?: { accept(): void; dispose(callback: () => void): void };
}
