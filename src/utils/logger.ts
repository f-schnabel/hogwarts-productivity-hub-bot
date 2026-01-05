// Operation ID generator for tracing related logs
let opCounter = 0;
const genOpId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(++opCounter % 1000).toString().padStart(3, "0")}`;

export const OpId = {
  cmd: () => genOpId("cmd"),
  vc: () => genOpId("vc"),
  rst: () => genOpId("rst"),
  msg: () => genOpId("msg"),
  vcscan: () => genOpId("vcscan"),
  start: () => genOpId("start"),
  shtdwn: () => genOpId("shtdwn"),
};

// Context formatter: [opId] key=val key2=val2
type Ctx = { opId: string } & Record<string, unknown>;
const fmt = (ctx?: Ctx) => {
  if (!ctx) return "";
  const { opId, ...rest } = ctx;
  const parts = opId ? [`[${opId}]`] : [];
  parts.push(
    ...Object.entries(rest)
      .filter(([, v]) => v !== undefined)
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      .map(([k, v]) => `${k}=${v}`),
  );
  return parts.join(" ") + " ";
};

// Scoped logger factory
export const createLogger = (scope: string) => ({
  debug: (msg: string, ctx?: Ctx) => {
    console.debug(`[${scope}] ${fmt(ctx)}${msg}`);
  },
  info: (msg: string, ctx?: Ctx) => {
    console.log(`[${scope}] ${fmt(ctx)}${msg}`);
  },
  warn: (msg: string, ctx?: Ctx) => {
    console.warn(`[${scope}] ${fmt(ctx)}${msg}`);
  },
  error: (msg: string, ctx?: Ctx, err?: unknown) => {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-base-to-string
    const errStr = err instanceof Error ? `: ${err.message}` : err ? `: ${err}` : "";
    console.error(`[${scope}] ${fmt(ctx)}${msg}${errStr}`);
  },
});
