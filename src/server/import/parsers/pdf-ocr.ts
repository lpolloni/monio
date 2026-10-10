/** Local OCR: packaged language data, no document or image leaves this process. */
import { access } from "node:fs/promises";
import { join } from "node:path";
import language from "@tesseract.js-data/por";
import { createWorker, type Worker } from "tesseract.js";

export async function createPdfOcrWorker(): Promise<Worker> {
  // Use the package's own runtime path. Turbopack's require.resolve() returns a
  // module identifier for externals, which is not a filesystem path.
  await access(join(language.langPath, "por.traineddata.gz"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let rejectFailure: (error: Error) => void = () => {};
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  const pending = createWorker("por", 1, {
    langPath: language.langPath, gzip: true, cacheMethod: "none",
    errorHandler: error => rejectFailure(new Error(String(error))),
  });
  // A late initialization must not leave a live worker after the caller gave up.
  pending.then(worker => { if (expired) void worker.terminate(); }, () => {});
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("PDF OCR initialization timed out")), 20_000);
    });
    return await Promise.race([pending, failure, timeout]);
  } catch (error) {
    expired = true;
    throw error;
  } finally { clearTimeout(timer); }
}
