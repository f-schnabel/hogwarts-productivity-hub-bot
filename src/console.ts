const oldConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
  trace: console.trace.bind(console),
};

const SystemDLogPriority = {
  Error: 3,
  Warning: 4,
  Info: 6,
  Debug: 7,
} as const;

/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-explicit-any */
console.log = (...args: any[]) => {
  oldConsole.log(`<${SystemDLogPriority.Info}>`, ...args);
};

console.error = (...args: any[]) => {
  oldConsole.error(`<${SystemDLogPriority.Error}>`, ...args);
};

console.warn = (...args: any[]) => {
  oldConsole.warn(`<${SystemDLogPriority.Warning}>`, ...args);
};

console.info = (...args: any[]) => {
  oldConsole.info(`<${SystemDLogPriority.Info}>`, ...args);
};

console.debug = (...args: any[]) => {
  oldConsole.debug(`<${SystemDLogPriority.Debug}>`, ...args);
};

console.trace = (...args: any[]) => {
  oldConsole.trace(`<${SystemDLogPriority.Debug}>`, ...args);
};
/* eslint-enable @typescript-eslint/no-unsafe-argument */
/* eslint-enable @typescript-eslint/no-explicit-any */
