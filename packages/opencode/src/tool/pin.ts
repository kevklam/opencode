import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { Pin } from "../session/pin"
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"

function describePinTarget(pin: Pin.Info) {
  const relative = path.relative(Instance.worktree, pin.path)
  return pin.locator ? `${relative}:${pin.locator}` : relative
}

const PIN_TOOL_DESCRIPTION = `
Use these tools to keep durable session context active across turns.

- Use pin_file for a whole file that should stay in scope.
- Use pin_section for a targeted line range when only part of a file matters.
- Use list_pins to inspect the current durable working set.
- Use unpin when pinned context is no longer relevant.
- If the user gives an exact file, line, or column range, call the pin tool directly. Do not read the file first unless you need to resolve ambiguity or answer a separate content question.
`.trim()

export const PinFileTool = Tool.define("pin_file", {
  description: `${PIN_TOOL_DESCRIPTION}\n\nPin a file into durable per-session context.`,
  parameters: z.object({
    path: z.string().describe("Absolute or workspace-relative path to the file to pin"),
  }),
  async execute(params, ctx) {
    const filepath = Pin.resolveFilePath(params.path)
    const stat = Filesystem.stat(filepath)
    if (!stat) throw new Error(`File not found: ${filepath}`)
    if (!stat.isFile()) throw new Error(`Path is not a file: ${filepath}`)

    const result = Pin.pinFile({ sessionID: ctx.sessionID, path: filepath })
    const relative = path.relative(Instance.worktree, filepath)
    return {
      title: relative,
      output: result.changed
        ? `${relative} pinned. Pin id: ${result.pinID}. This file is now part of the session's pinned context.`
        : `${relative} already pinned. Pin id: ${result.pinID}. This file was already part of the session's pinned context.`,
      metadata: {},
    }
  },
})

export const PinSectionTool = Tool.define("pin_section", {
  description: `${PIN_TOOL_DESCRIPTION}\n\nPin a line range from a file into durable per-session context. Lines and columns are 1-based and inclusive.`,
  parameters: z.object({
    path: z.string().describe("Absolute or workspace-relative path to the file to pin"),
    start_line: z.number().int().positive().describe("1-based inclusive start line"),
    start_column: z.number().int().positive().optional().describe("1-based inclusive start column"),
    end_line: z.number().int().positive().describe("1-based inclusive end line"),
    end_column: z.number().int().positive().optional().describe("1-based inclusive end column"),
  }),
  async execute(params, ctx) {
    if (params.start_line > params.end_line) {
      throw new Error("start_line must be less than or equal to end_line")
    }
    if (params.end_line - params.start_line + 1 > 400) {
      throw new Error("Pinned section is too large; max 400 lines")
    }
    if (params.start_line === params.end_line && params.start_column && params.end_column) {
      if (params.start_column > params.end_column) {
        throw new Error("start_column must be less than or equal to end_column when pinning within one line")
      }
    }

    const filepath = Pin.resolveFilePath(params.path)
    const stat = Filesystem.stat(filepath)
    if (!stat) throw new Error(`File not found: ${filepath}`)
    if (!stat.isFile()) throw new Error(`Path is not a file: ${filepath}`)

    const result = Pin.pinSection({
      sessionID: ctx.sessionID,
      path: filepath,
      startLine: params.start_line,
      startColumn: params.start_column,
      endLine: params.end_line,
      endColumn: params.end_column,
    })
    const locator = Pin.makeLocator({
      startLine: params.start_line,
      startColumn: params.start_column,
      endLine: params.end_line,
      endColumn: params.end_column,
    })
    const relative = path.relative(Instance.worktree, filepath)
    return {
      title: `${relative}:${locator}`,
      output: result.changed
        ? `${relative}:${locator} pinned. Pin id: ${result.pinID}. This section is now part of the session's pinned context.`
        : `${relative}:${locator} already pinned. Pin id: ${result.pinID}. This section was already part of the session's pinned context.`,
      metadata: {},
    }
  },
})

export const UnpinTool = Tool.define("unpin", {
  description: `${PIN_TOOL_DESCRIPTION}\n\nRemove a pinned item by pin id.`,
  parameters: z.object({
    target: z.string().describe("Pin id returned by pin_file or pin_section"),
  }),
  async execute(params, ctx) {
    const removed = Pin.unpin({ sessionID: ctx.sessionID, target: params.target })
    if (!removed.changed || !removed.pin) {
      throw new Error(`Pin not found: ${params.target}`)
    }
    const target = describePinTarget(removed.pin)
    return {
      title: target,
      output: `${target} unpinned. Pin id: ${params.target}. This ${removed.pin.kind} is no longer part of the session's pinned context.`,
      metadata: {},
    }
  },
})

export const ListPinsTool = Tool.define("list_pins", {
  description: `${PIN_TOOL_DESCRIPTION}\n\nList the currently pinned context for the session.`,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const pins = Pin.list(ctx.sessionID)
    return {
      title: `${pins.length} pins`,
      output: JSON.stringify({ status: "success", pins }, null, 2),
      metadata: { pins },
    }
  },
})
