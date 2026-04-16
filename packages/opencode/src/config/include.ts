import { NamedError } from "@opencode-ai/util/error"
import path from "path"
import { z } from "zod"
import { Filesystem } from "../util/filesystem"

const INCLUDE_REGEX = /^!include\s+(?:"([^"]+)"|'([^']+)'|(.+?))\s*$/gm

export namespace ConfigInclude {
  export const IncludeError = NamedError.create(
    "ConfigIncludeError",
    z.object({
      path: z.string(),
      message: z.string(),
    }),
  )

  export async function expand(filePath: string, visited: string[] = []): Promise<string> {
    const resolvedPath = path.resolve(filePath)
    if (visited.includes(resolvedPath)) {
      throw new IncludeError({
        path: resolvedPath,
        message: `Include cycle detected: ${[...visited, resolvedPath].join(" -> ")}`,
      })
    }

    const template = await Filesystem.readText(resolvedPath)
    const nextVisited = [...visited, resolvedPath]
    const matches = Array.from(template.matchAll(INCLUDE_REGEX))
    if (matches.length === 0) return template

    let result = ""
    let lastIndex = 0

    for (const match of matches) {
      const [fullMatch, doubleQuotedPath, singleQuotedPath, barePath] = match
      const includePath = (doubleQuotedPath ?? singleQuotedPath ?? barePath ?? "").trim()
      const matchIndex = match.index ?? 0
      result += template.slice(lastIndex, matchIndex)

      const target = path.resolve(path.dirname(resolvedPath), includePath)
      let included = await expand(target, nextVisited)
      lastIndex = matchIndex + fullMatch.length
      const nextChar = template.slice(lastIndex, lastIndex + 1)
      if (included.endsWith("\r\n") && nextChar === "\n") included = included.slice(0, -2)
      else if (included.endsWith("\n") && nextChar === "\n") included = included.slice(0, -1)
      result += included
    }

    result += template.slice(lastIndex)
    return result
  }
}
