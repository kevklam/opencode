import { Effect, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { Pin } from "../session/pin"
import { InstanceState } from "@/effect/instance-state"
import { Filesystem } from "@/util/filesystem"
import { PositiveInt } from "@/util/schema"

function describePinTarget(worktree: string, pin: Pin.Info) {
  const relative = path.relative(worktree, pin.path)
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

export const PinFileTool = Tool.define(
  "pin_file",
  Effect.gen(function* () {
    return {
      description: `${PIN_TOOL_DESCRIPTION}\n\nPin a file into durable per-session context.`,
      parameters: Schema.Struct({
        path: Schema.String.annotate({ description: "Absolute or workspace-relative path to the file to pin" }),
      }),
      execute: (params: { path: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = Pin.resolveFilePath(params.path)
          const stat = Filesystem.stat(filepath)
          if (!stat) throw new Error(`File not found: ${filepath}`)
          if (!stat.isFile()) throw new Error(`Path is not a file: ${filepath}`)

          const result = Pin.pinFile({ sessionID: ctx.sessionID, path: filepath })
          const relative = path.relative(instance.worktree, filepath)
          return {
            title: relative,
            output: result.changed
              ? `${relative} pinned. Pin id: ${result.pinID}. This file is now part of the session's pinned context.`
              : `${relative} already pinned. Pin id: ${result.pinID}. This file was already part of the session's pinned context.`,
            metadata: {},
          }
        }),
    }
  }),
)

export const PinSectionTool = Tool.define(
  "pin_section",
  Effect.gen(function* () {
    return {
      description: `${PIN_TOOL_DESCRIPTION}\n\nPin a line range from a file into durable per-session context. Lines and columns are 1-based and inclusive.`,
      parameters: Schema.Struct({
        path: Schema.String.annotate({ description: "Absolute or workspace-relative path to the file to pin" }),
        start_line: PositiveInt.annotate({
          description: "1-based inclusive start line",
        }),
        start_column: Schema.optional(PositiveInt).annotate({
          description: "1-based inclusive start column",
        }),
        end_line: PositiveInt.annotate({
          description: "1-based inclusive end line",
        }),
        end_column: Schema.optional(PositiveInt).annotate({
          description: "1-based inclusive end column",
        }),
      }),
      execute: (
        params: {
          path: string
          start_line: number
          start_column?: number
          end_line: number
          end_column?: number
        },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          if (params.start_line > params.end_line) {
            throw new Error("start_line must be less than or equal to end_line")
          }
          if (params.end_line - params.start_line + 1 > 400) {
            throw new Error("Pinned section is too large; max 400 lines")
          }
          if (
            params.start_line === params.end_line &&
            params.start_column &&
            params.end_column &&
            params.start_column > params.end_column
          ) {
            throw new Error("start_column must be less than or equal to end_column when pinning within one line")
          }

          const instance = yield* InstanceState.context
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
          const relative = path.relative(instance.worktree, filepath)
          return {
            title: `${relative}:${locator}`,
            output: result.changed
              ? `${relative}:${locator} pinned. Pin id: ${result.pinID}. This section is now part of the session's pinned context.`
              : `${relative}:${locator} already pinned. Pin id: ${result.pinID}. This section was already part of the session's pinned context.`,
            metadata: {},
          }
        }),
    }
  }),
)

export const UnpinTool = Tool.define(
  "unpin",
  Effect.gen(function* () {
    return {
      description: `${PIN_TOOL_DESCRIPTION}\n\nRemove a pinned item by pin id.`,
      parameters: Schema.Struct({
        target: Schema.String.annotate({ description: "Pin id returned by pin_file or pin_section" }),
      }),
      execute: (params: { target: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const removed = Pin.unpin({ sessionID: ctx.sessionID, target: params.target })
          if (!removed.changed || !removed.pin) {
            throw new Error(`Pin not found: ${params.target}`)
          }
          const target = describePinTarget(instance.worktree, removed.pin)
          return {
            title: target,
            output: `${target} unpinned. Pin id: ${params.target}. This ${removed.pin.kind} is no longer part of the session's pinned context.`,
            metadata: {},
          }
        }),
    }
  }),
)

export const ListPinsTool = Tool.define(
  "list_pins",
  Effect.gen(function* () {
    return {
      description: `${PIN_TOOL_DESCRIPTION}\n\nList the currently pinned context for the session.`,
      parameters: Schema.Struct({}),
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const pins = Pin.list(ctx.sessionID)
          return {
            title: `${pins.length} pins`,
            output: JSON.stringify({ status: "success", pins }, null, 2),
            metadata: { pins },
          }
        }),
    }
  }),
)
