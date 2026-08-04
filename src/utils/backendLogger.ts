import fs from 'fs';
import path from 'path';

const logDir = process.cwd();
const masterLogPath = path.join(logDir, 'master.log');
const errorLogPath = path.join(logDir, 'error.log');

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

function appendToFile(filePath: string, prefix: string, args: any[]) {
  try {
    const formatted = args.map(a => {
      if (a instanceof Error) {
        return a.message + (a.stack ? `\n${a.stack}` : '');
      }
      return typeof a === 'object' ? JSON.stringify(a) : String(a);
    }).join(' ');

    const line = `[${prefix}] ${new Date().toISOString()} - ${formatted}\n`;
    fs.appendFileSync(filePath, line, 'utf8');
  } catch (err) {
    // Fail-safe to avoid console loop
  }
}

// Wrap console loggers
console.log = (...args: any[]) => {
  appendToFile(masterLogPath, 'INFO', args);
  originalLog.apply(console, args);
};

console.info = (...args: any[]) => {
  appendToFile(masterLogPath, 'INFO', args);
  originalInfo.apply(console, args);
};

console.warn = (...args: any[]) => {
  appendToFile(masterLogPath, 'WARN', args);
  appendToFile(errorLogPath, 'WARN', args); // Log warnings as error potential
  originalWarn.apply(console, args);
};

console.error = (...args: any[]) => {
  appendToFile(masterLogPath, 'ERROR', args);
  appendToFile(errorLogPath, 'ERROR', args); // Log errors separately
  originalError.apply(console, args);
};

originalLog(`[INIT] Backend rolling file logger initialized. Logs: ${masterLogPath}, Errors: ${errorLogPath}`);
