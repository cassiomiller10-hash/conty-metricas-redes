export type Clock = {
  now(): Date;
  /** Espera `ms`. Resolve `true` se o tempo passou, `false` se `signal` cancelou antes. */
  sleep(ms: number, signal?: AbortSignal): Promise<boolean>;
};

// Usa Date e setTimeout globais: nos testes, os timers falsos do Vitest controlam os dois.
export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve(false);
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", cancel);
        resolve(true);
      }, ms);
      const cancel = () => {
        clearTimeout(timer);
        resolve(false);
      };
      signal?.addEventListener("abort", cancel, { once: true });
    }),
};
