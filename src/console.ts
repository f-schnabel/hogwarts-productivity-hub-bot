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

type Priority = (typeof SystemDLogPriority)[keyof typeof SystemDLogPriority];

/* eslint-disable @typescript-eslint/no-explicit-any */
const formatWithPriority = (priority: Priority, args: any[]): string => {
  const message = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
  return `<${priority}>${message.replace(/\n/g, " ")}`;
};

console.log = (...args: any[]) => {
  oldConsole.log(formatWithPriority(SystemDLogPriority.Info, args));
};

console.error = (...args: any[]) => {
  oldConsole.error(formatWithPriority(SystemDLogPriority.Error, args));
};

console.warn = (...args: any[]) => {
  oldConsole.warn(formatWithPriority(SystemDLogPriority.Warning, args));
};

console.info = (...args: any[]) => {
  oldConsole.info(formatWithPriority(SystemDLogPriority.Info, args));
};

console.debug = (...args: any[]) => {
  oldConsole.debug(formatWithPriority(SystemDLogPriority.Debug, args));
};

console.trace = (...args: any[]) => {
  oldConsole.trace(formatWithPriority(SystemDLogPriority.Debug, args));
};
/* eslint-enable @typescript-eslint/no-explicit-any */
