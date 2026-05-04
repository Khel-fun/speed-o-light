import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";
import fs from "fs";

// Ensure logs directory exists
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const format = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, service, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : "";
    return `[${timestamp}] [${level.toUpperCase()}] [${service}] ${stack || message} ${metaStr}`;
  })
);

// Shared singleton — one writer to the aggregated error file
const errorTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, `error-%DATE%.log`),
  datePattern: "YYYY-MM-DD",
  level: "error",
  maxFiles: "30d",
  maxSize: "50m",
});

export function createLogger(service: string) {
  return winston.createLogger({
    defaultMeta: { service },
    format,
    exceptionHandlers: [
  // uncaught exception
      new DailyRotateFile({
        filename: path.join(LOG_DIR, `${service}-exceptions-%DATE%.log`),
        datePattern: "YYYY-MM-DD",
        maxFiles: "30d",
      }),
    ],
    rejectionHandlers: [
  // unhandled promise rejection
      new DailyRotateFile({
        filename: path.join(LOG_DIR, `${service}-rejections-%DATE%.log`),
        datePattern: "YYYY-MM-DD",
        maxFiles: "30d",
      }),
    ],
    transports: [
    // Service-specific file — only specific service's logs, rotated daily
      new DailyRotateFile({
        filename: path.join(LOG_DIR, `${service}-%DATE%.log`),
        datePattern: "YYYY-MM-DD",
        maxFiles: "30d",
        maxSize: "50m",
      }),

  // Shared singleton
      errorTransport,

  // Console — PM2 captures this into its own stdout log
      new winston.transports.Console({
        level: process.env.LOG_LEVEL || "info",
      }),
    ],
  });
}
