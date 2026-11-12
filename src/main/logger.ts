import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './paths'

function write(level: 'INFO' | 'WARN' | 'ERROR', message: string, detail?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${
    detail === undefined ? '' : ` ${safeDetail(detail)}`
  }\n`
  try {
    fs.mkdirSync(path.join(getDataDir(), 'logs'), { recursive: true })
    fs.appendFileSync(path.join(getDataDir(), 'logs', 'app.log'), line, 'utf8')
  } catch {
    // Logging must never break the app.
  }
  if (level === 'ERROR') {
    console.error(line.trim())
  } else if (process.env.NODE_ENV !== 'production') {
    console.log(line.trim())
  }
}

function safeDetail(detail: unknown): string {
  if (detail instanceof Error) return detail.stack ?? detail.message
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

export const logger = {
  info: (message: string, detail?: unknown) => write('INFO', message, detail),
  warn: (message: string, detail?: unknown) => write('WARN', message, detail),
  error: (message: string, detail?: unknown) => write('ERROR', message, detail)
}
