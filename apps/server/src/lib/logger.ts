import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ["req.headers.cookie", "req.headers.authorization", "*.token", "*.password"],
});
export type Logger = typeof logger;
