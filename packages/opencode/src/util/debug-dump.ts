import fs from "fs/promises"
import path from "path"

export async function appendDebugDump(payload: unknown, logfile: string) {
  await fs.mkdir(path.dirname(logfile), { recursive: true })
  await fs.appendFile(logfile, JSON.stringify(payload) + "\n")
}
