import * as path from "path"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "./schema"
import { Database, asc, eq } from "../storage/db"
import { PinTable } from "./session.sql"
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"
import { FileTime } from "@/file/time"

const MAX_PIN_BYTES = 24_000
const MAX_TOTAL_PIN_BYTES = 60_000
const MAX_SECTION_LINES = 400
const TRUNCATION_SUFFIX = "\n[truncated]\n"

export namespace Pin {
  export const Kind = z.enum(["file", "section"]).meta({ ref: "PinKind" })
  export type Kind = z.infer<typeof Kind>

  export const Info = z
    .object({
      id: z.string(),
      kind: Kind,
      path: z.string(),
      locator: z.string().optional(),
    })
    .meta({ ref: "Pin" })
  export type Info = z.infer<typeof Info>

  export const Stored = Info.extend({
    startLine: z.number().int().positive().optional(),
    startColumn: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    endColumn: z.number().int().positive().optional(),
    position: z.number().int().nonnegative(),
  })
  export type Stored = z.infer<typeof Stored>

  export const Event = {
    Updated: BusEvent.define(
      "pin.updated",
      z.object({
        sessionID: SessionID.zod,
        pins: z.array(Info),
      }),
    ),
  }

  function makePinID() {
    return `pin_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`
  }

  function normalizePinPath(filepath: string) {
    return Filesystem.normalizePath(filepath)
  }

  export function resolveFilePath(filepath: string) {
    const resolved = path.isAbsolute(filepath) ? filepath : path.resolve(Instance.directory, filepath)
    return normalizePinPath(resolved)
  }

  export function makeLocator(input: {
    startLine: number
    startColumn?: number
    endLine: number
    endColumn?: number
  }) {
    const start =
      input.startColumn !== undefined ? `L${input.startLine}:C${input.startColumn}` : `L${input.startLine}`
    const end = input.endColumn !== undefined ? `L${input.endLine}:C${input.endColumn}` : `L${input.endLine}`
    return `${start}-${end}`
  }

  function toInfo(pin: Stored): Info {
    return {
      id: pin.id,
      kind: pin.kind,
      path: pin.path,
      locator:
        pin.kind === "section" && pin.startLine && pin.endLine
          ? makeLocator({
              startLine: pin.startLine,
              startColumn: pin.startColumn,
              endLine: pin.endLine,
              endColumn: pin.endColumn,
            })
          : undefined,
    }
  }

  function fromRow(row: typeof PinTable.$inferSelect): Stored {
    return {
      id: row.id,
      kind: Kind.parse(row.kind),
      path: row.path,
      startLine: row.start_line ?? undefined,
      startColumn: row.start_column ?? undefined,
      endLine: row.end_line ?? undefined,
      endColumn: row.end_column ?? undefined,
      position: row.position,
      locator:
        row.kind === "section" && row.start_line && row.end_line
          ? makeLocator({
              startLine: row.start_line,
              startColumn: row.start_column ?? undefined,
              endLine: row.end_line,
              endColumn: row.end_column ?? undefined,
            })
          : undefined,
    }
  }

  function getFrom(db: Database.TxOrDb, sessionID: SessionID): Stored[] {
    const rows = db.select().from(PinTable).where(eq(PinTable.session_id, sessionID)).orderBy(asc(PinTable.position)).all()
    return rows.map(fromRow)
  }

  export function get(sessionID: SessionID): Stored[] {
    return Database.use((db) => getFrom(db, sessionID))
  }

  export function list(sessionID: SessionID): Info[] {
    return get(sessionID).map(toInfo)
  }

  function publish(sessionID: SessionID) {
    Bus.publish(Event.Updated, {
      sessionID,
      pins: list(sessionID),
    })
  }

  export function pinFile(input: { sessionID: SessionID; path: string }) {
    const normalized = normalizePinPath(input.path)
    const result = Database.transaction(
      (db) => {
        const existingPins = getFrom(db, input.sessionID)
        const existing = existingPins.find((pin) => pin.kind === "file" && pin.path === normalized)
        if (existing) return { pinID: existing.id, changed: false }

        const id = makePinID()
        const now = Date.now()
        db.insert(PinTable)
          .values({
            session_id: input.sessionID,
            id,
            kind: "file",
            path: normalized,
            position: existingPins.length,
            time_created: now,
            time_updated: now,
          })
          .run()
        return { pinID: id, changed: true }
      },
      { behavior: "immediate" },
    )
    if (result.changed) publish(input.sessionID)
    return {
      pinID: result.pinID,
      changed: result.changed,
    }
  }

  export function pinSection(input: {
    sessionID: SessionID
    path: string
    startLine: number
    startColumn?: number
    endLine: number
    endColumn?: number
  }) {
    const normalized = normalizePinPath(input.path)
    const result = Database.transaction(
      (db) => {
        const existingPins = getFrom(db, input.sessionID)
        const existing = existingPins.find(
          (pin) =>
            pin.kind === "section" &&
            pin.path === normalized &&
            pin.startLine === input.startLine &&
            pin.startColumn === input.startColumn &&
            pin.endLine === input.endLine &&
            pin.endColumn === input.endColumn,
        )
        if (existing) return { pinID: existing.id, changed: false }

        const id = makePinID()
        const now = Date.now()
        db.insert(PinTable)
          .values({
            session_id: input.sessionID,
            id,
            kind: "section",
            path: normalized,
            start_line: input.startLine,
            start_column: input.startColumn,
            end_line: input.endLine,
            end_column: input.endColumn,
            position: existingPins.length,
            time_created: now,
            time_updated: now,
          })
          .run()
        return { pinID: id, changed: true }
      },
      { behavior: "immediate" },
    )
    if (result.changed) publish(input.sessionID)
    return {
      pinID: result.pinID,
      changed: result.changed,
    }
  }

  export function unpin(input: { sessionID: SessionID; target: string }) {
    const result = Database.transaction(
      (db) => {
        const pins = getFrom(db, input.sessionID)
        const removed = pins.find((pin) => pin.id === input.target)
        const next = pins.filter((pin) => pin.id !== input.target)
        if (!removed) return { changed: false as const, pin: undefined }

        const now = Date.now()
        db.delete(PinTable).where(eq(PinTable.session_id, input.sessionID)).run()
        if (next.length > 0) {
          db.insert(PinTable)
            .values(
              next.map((pin, position) => ({
                session_id: input.sessionID,
                id: pin.id,
                kind: pin.kind,
                path: pin.path,
                start_line: pin.startLine,
                start_column: pin.startColumn,
                end_line: pin.endLine,
                end_column: pin.endColumn,
                position,
                time_created: now,
                time_updated: now,
              })),
            )
            .run()
        }
        return { changed: true as const, pin: toInfo(removed) }
      },
      { behavior: "immediate" },
    )
    if (result.changed) publish(input.sessionID)
    return result
  }

  export function toolInstructions() {
    return [
      "Use pin_file or pin_section when reference material should stay active across multiple turns.",
      "When the user asks to pin an exact file, line, or column range, call the matching pin tool directly instead of reading and manually counting content first.",
      "After pin_section succeeds, do not call read just to inspect the pinned range; use the pinned context made available to you in the next model step.",
      "Pinned file and section context is snapshotted before each model step and counts as fresh file context for edit/write tools. Do not call read only to satisfy edit/write freshness when the relevant file content appears in the injected pinned context.",
      "pin_section line and column coordinates are 1-based and inclusive.",
      "Use list_pins to inspect the current working set and unpin when that durable context is no longer relevant.",
    ].join("\n")
  }

  async function renderContextSections(sessionID: SessionID) {
    const pins = get(sessionID)
    if (pins.length === 0) return undefined

    let remaining = MAX_TOTAL_PIN_BYTES
    const sections: string[] = []

    for (const pin of pins) {
      if (remaining <= 0) break
      const content = await readPinContent(sessionID, pin).catch((error) => `unavailable (${String(error)})`)
      const bounded = truncateUtf8(content, Math.min(MAX_PIN_BYTES, remaining))
      remaining -= Buffer.byteLength(bounded, "utf8")

      const header = [
        `Pinned context item: ${pin.id}`,
        `kind: ${pin.kind}`,
        `path: ${pin.path}`,
        ...(pin.locator ? [`locator: ${pin.locator}`] : []),
      ]

      sections.push(`${header.join("\n")}\nBEGIN_${pin.id}\n${bounded}\nEND_${pin.id}`)
    }

    if (sections.length === 0) return undefined
    return sections
  }

  export async function renderSystemMessage(sessionID: SessionID) {
    const sections = await renderContextSections(sessionID)
    if (!sections) return undefined

    return [
      "Pinned context: these items are part of your active working set for this session.",
      "This pinned context reflects all pin/unpin tool calls that have completed so far, including tools you may have called earlier in the current assistant turn.",
      "If your latest pin_file or pin_section tool result said an item was pinned, treat the matching item here as newly pinned by that tool, not as evidence that it was already pinned.",
      "Only say an item was already pinned when the pin tool result itself says it was already pinned, or when you observed that pin in an earlier turn.",
      "Do not describe this context block to the user; just use it as active context.",
      ...sections,
    ].join("\n\n")
  }

  export async function renderUserMessage(sessionID: SessionID) {
    const sections = await renderContextSections(sessionID)
    if (!sections) return undefined

    return [
      "Pinned context for this turn: use the following session-pinned material as active working context.",
      "This pinned context reflects all pin/unpin tool calls that have completed so far, including tools you may have called earlier in the current assistant turn.",
      "If your latest pin_file or pin_section tool result said an item was pinned, treat the matching item here as newly pinned by that tool, not as evidence that it was already pinned.",
      "Only say an item was already pinned when the pin tool result itself says it was already pinned, or when you observed that pin in an earlier turn.",
      "Do not quote or narrate this block by default; just use it as context unless the user asks about the pinned content directly.",
      ...sections,
    ].join("\n\n")
  }

  async function readPinContent(sessionID: SessionID, pin: Stored) {
    const content = await Filesystem.readText(pin.path)
    await FileTime.read(sessionID, pin.path)
    if (pin.kind === "file") return content
    return sliceSection(content, pin)
  }

  function sliceSection(content: string, pin: Stored) {
    if (!pin.startLine || !pin.endLine) return ""
    if (pin.endLine - pin.startLine + 1 > MAX_SECTION_LINES) {
      throw new Error(`Pinned section exceeds ${MAX_SECTION_LINES} lines`)
    }

    const lines = content.split(/\r?\n/)
    if (lines.length === 0) return ""

    const start = Math.min(Math.max(pin.startLine - 1, 0), lines.length)
    const end = Math.min(Math.max(pin.endLine, 0), lines.length)
    if (start >= end) return ""

    const selected = lines.slice(start, end)
    if (selected.length === 1) {
      const original = selected[0]
      const startIdx = columnToByteIndex(original, pin.startColumn ?? 1)
      const endIdx = pin.endColumn ? columnToByteIndexAfterChar(original, pin.endColumn) : Buffer.byteLength(original)
      return original.slice(startIdx, Math.max(startIdx, endIdx))
    }

    if (selected.length > 0) {
      selected[0] = selected[0].slice(columnToByteIndex(selected[0], pin.startColumn ?? 1))
      if (pin.endColumn) {
        selected[selected.length - 1] = selected[selected.length - 1].slice(
          0,
          columnToByteIndexAfterChar(selected[selected.length - 1], pin.endColumn),
        )
      }
    }

    return selected.join("\n")
  }

  function columnToByteIndex(line: string, column: number) {
    if (column <= 1) return 0
    const idx = Array.from(line).slice(0, column - 1).join("").length
    return Math.min(idx, line.length)
  }

  function columnToByteIndexAfterChar(line: string, column: number) {
    if (column <= 0) return 0
    const idx = Array.from(line).slice(0, column).join("").length
    return Math.min(idx, line.length)
  }

  function truncateUtf8(text: string, maxBytes: number) {
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return text

    let output = ""
    for (const char of text) {
      const next = output + char
      if (Buffer.byteLength(next + TRUNCATION_SUFFIX, "utf8") > maxBytes) break
      output = next
    }
    return output + TRUNCATION_SUFFIX
  }
}
