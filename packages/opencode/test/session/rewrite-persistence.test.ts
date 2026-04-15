import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("session rewrite persistence", () => {
  test("updated text parts are reflected by later session reads", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const message = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "test", modelID: "test" },
          time: { created: Date.now() },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)

        const firstPart = await Session.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: "before",
        })

        await Session.updatePart({
          ...firstPart,
          text: "after",
        })

        const updated = await Session.messages({ sessionID: session.id })
        expect(updated).toHaveLength(1)
        expect(updated[0].parts).toHaveLength(1)
        expect(updated[0].parts[0]).toMatchObject({
          id: firstPart.id,
          type: "text",
          text: "after",
        })
      },
    })
  })
})
