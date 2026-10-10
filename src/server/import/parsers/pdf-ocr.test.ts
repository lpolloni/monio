import { afterEach, expect, it, vi } from "vitest";
import { createWorker, type Worker } from "tesseract.js";
import { createPdfOcrWorker } from "./pdf-ocr";

vi.mock("tesseract.js", () => ({ createWorker: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it("uses the packaged language's real filesystem directory", async () => {
  const worker = { terminate: vi.fn() } as unknown as Worker;
  vi.mocked(createWorker).mockResolvedValue(worker);
  expect(await createPdfOcrWorker()).toBe(worker);
  const options = vi.mocked(createWorker).mock.calls[0]![2]!;
  expect(options.langPath).toContain("@tesseract.js-data/por/4.0.0");
  expect(options.langPath).not.toContain("[externals]");
});

it("rejects initialization errors instead of leaving the import waiting", async () => {
  vi.mocked(createWorker).mockImplementation(async (_lang, _mode, options) => {
    queueMicrotask(() => options!.errorHandler!(new Error("fictional language load failure")));
    return new Promise<Worker>(() => {});
  });
  await expect(createPdfOcrWorker()).rejects.toThrow("fictional language load failure");
});

it("bounds initialization and terminates a worker that finishes after timeout", async () => {
  vi.useFakeTimers();
  let resolveWorker!: (worker: Worker) => void;
  vi.mocked(createWorker).mockImplementation(() => new Promise(resolve => { resolveWorker = resolve; }));
  const pending = createPdfOcrWorker();
  const assertion = expect(pending).rejects.toThrow("timed out");
  // Allow the real filesystem preflight to finish before advancing virtual time.
  await vi.waitFor(() => expect(createWorker).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(20_000);
  await assertion;
  const terminate = vi.fn().mockResolvedValue(undefined);
  resolveWorker({ terminate } as unknown as Worker);
  await Promise.resolve();
  expect(terminate).toHaveBeenCalledOnce();
});
