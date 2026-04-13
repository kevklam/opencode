import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Pin } from "../../src/session/pin"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

describe("session.pin", () => {
  test("stores and lists durable file and section pins", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filepath = path.join(tmp.path, "notes.txt")
        await Bun.write(filepath, "alpha\nbeta\ngamma\ndelta\n")

        const session = await Session.create({})
        const filePin = Pin.pinFile({ sessionID: session.id, path: filepath })
        const sectionPin = Pin.pinSection({
          sessionID: session.id,
          path: filepath,
          startLine: 2,
          endLine: 3,
        })

        expect(filePin.pinID).toBeTruthy()
        expect(filePin.changed).toBe(true)
        expect(sectionPin.pinID).toBeTruthy()
        expect(sectionPin.changed).toBe(true)

        const duplicateFilePin = Pin.pinFile({ sessionID: session.id, path: filepath })
        expect(duplicateFilePin.pinID).toBe(filePin.pinID)
        expect(duplicateFilePin.changed).toBe(false)

        expect(Pin.list(session.id)).toEqual([
          {
            id: filePin.pinID,
            kind: "file",
            path: filepath,
          },
          {
            id: sectionPin.pinID,
            kind: "section",
            path: filepath,
            locator: "L2-L3",
          },
        ])
      },
    })
  })

  test("renders pinned context into a dedicated system message and supports unpin", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filepath = path.join(tmp.path, "guide.md")
        await Bun.write(filepath, "# Guide\nLine two\nLine three\n")

        const session = await Session.create({})
        const { pinID } = Pin.pinSection({
          sessionID: session.id,
          path: filepath,
          startLine: 2,
          endLine: 3,
        })

        const rendered = await Pin.renderSystemMessage(session.id)
        expect(rendered).toContain("Pinned context: these items are part of your active working set")
        expect(rendered).toContain("including tools you may have called earlier in the current assistant turn")
        expect(rendered).toContain("treat the matching item here as newly pinned")
        expect(rendered).toContain("Do not describe this context block to the user")
        expect(rendered).toContain("kind: section")
        expect(rendered).toContain("locator: L2-L3")
        expect(rendered).toContain("Line two\nLine three")

        expect(Pin.unpin({ sessionID: session.id, target: pinID })).toMatchObject({
          changed: true,
          pin: {
            id: pinID,
            kind: "section",
            path: filepath,
            locator: "L2-L3",
          },
        })
        expect(Pin.list(session.id)).toEqual([])
      },
    })
  })
})
