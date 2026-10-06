import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import * as nodeOs from "os";
import { join } from "path";

const SID_ASSISTANT = "ses_clm_assistant";
const SID_DELETED = "ses_clm_deleted";

let homeDir: string;
let hooks: Record<string, (input: any, output?: any) => unknown>;
let originalClmEnv: string | undefined;

const mirrorPath = (sessionID: string) =>
  // homeDir is a mkdtempSync temp dir and sessionID is a module-level test
  // constant; no user input reaches this path.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  join(homeDir, ".local", "state", "opencode-clm", `LIVE_CTX_${sessionID}.txt`);

const readMirror = (sessionID: string): string => {
  try {
    return readFileSync(mirrorPath(sessionID), "utf-8");
  } catch {
    return "";
  }
};

beforeAll(async () => {
  homeDir = mkdtempSync(join(nodeOs.tmpdir(), "clm-plugin-"));
  originalClmEnv = process.env.OPENCODE_CLM;
  process.env.OPENCODE_CLM = "1";
  mock.module("os", () => ({ ...nodeOs, homedir: () => homeDir }));
  mock.module("@opencode-ai/plugin", () => {
    const schema = {
      enum: () => ({}),
      string: () => ({ optional: () => ({ describe: () => ({}) }) }),
    };
    const stub: any = () => ({});
    stub.schema = schema;
    return { tool: stub };
  });
  const { ClmContextPlugin } = await import("./clm-context.ts");
  hooks = (await ClmContextPlugin({
    client: { session: { messages: async () => ({ data: [] }) } },
  })) as typeof hooks;
});

afterAll(() => {
  if (originalClmEnv === undefined) delete process.env.OPENCODE_CLM;
  else process.env.OPENCODE_CLM = originalClmEnv;
  mock.restore();
  rmSync(homeDir, { recursive: true, force: true });
});

describe("CLM plugin event handling", () => {
  test("mirrors a settled assistant text part using the part's session id", async () => {
    await hooks["chat.message"](
      { sessionID: SID_ASSISTANT, messageID: "msg_u1" },
      { message: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
    );
    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: { id: "msg_a1", sessionID: SID_ASSISTANT, role: "assistant" } },
      },
    });
    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_a1",
            sessionID: SID_ASSISTANT,
            messageID: "msg_a1",
            type: "text",
            text: "hi there",
            time: { end: 123 },
          },
        },
      },
    });
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "msg_a1", sessionID: SID_ASSISTANT, role: "assistant", time: { completed: 456 } },
        },
      },
    });

    const mirror = readMirror(SID_ASSISTANT);
    expect(mirror).toContain("@@TURN assistant 2");
    expect(mirror).toContain("hi there");
  });

  test("clears session state on session.deleted so a re-delivered turn is mirrored again", async () => {
    const chat = () =>
      hooks["chat.message"](
        { sessionID: SID_DELETED, messageID: "msg_u1" },
        { message: { role: "user" }, parts: [{ type: "text", text: "first" }] },
      );

    await chat();
    expect((readMirror(SID_DELETED).match(/@@TURN user/g) ?? []).length).toBe(1);

    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: SID_DELETED } } } });

    await chat();
    expect((readMirror(SID_DELETED).match(/@@TURN user/g) ?? []).length).toBe(2);
  });
});
