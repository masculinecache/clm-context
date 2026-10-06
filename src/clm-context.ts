/**
 * CLM (Context Language Models) self-managed context plugin.
 *
 * The model's context is exposed as a live, per-session file it can read and
 * rewrite through the `context_edit` tool. The harness mirrors user turns
 * (via chat.message) and assistant turns (settled message.part.updated parts,
 * joined once per completed message.updated) into the file, injects it into
 * the system prompt once per session,
 * and enforces a token budget by rolling back newest turns when the mirror
 * grows too large. At compaction, the mirror is re-seeded from the compacted
 * summary instead of embedding the unbounded file.
 *
 * Inert by default: unless `clm.jsonc` sets `enabled: true` (or
 * `OPENCODE_CLM=1`), this plugin registers no hooks and no tools, so session
 * behavior is byte-for-byte identical to running without it.
 *
 * References: facebookresearch/context-language-models, arXiv:2609.37725.
 * Docs: ../README.md (coexistence contract with dcp + built-in compaction).
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  DEFAULT_BUDGET_TOKENS,
  type ClmConfig,
  type ClmRole,
  appendTurn,
  buildCompactionPrompt,
  effectiveBudget,
  enforceBudget,
  evaluateEdit,
  liveContextFileName,
  parseConfig,
  reseedLiveContext,
  resolveEnabled,
} from "../lib/clm-context-core";

const CONFIG_PATH = join(homedir(), ".config", "opencode", "clm.jsonc");
const STATE_DIR = join(homedir(), ".local", "state", "opencode-clm");

function loadConfig(): ClmConfig {
  try {
    return parseConfig(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(
      (p): p is { type: string; text: string } =>
        !!p &&
        typeof p === "object" &&
        (p as { type?: unknown }).type === "text" &&
        typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text)
    .join("\n");
}

function sessionIdFromEvent(e: {
  type?: string;
  properties?: {
    sessionID?: string;
    info?: { id?: string; sessionID?: string };
    part?: { sessionID?: string };
  };
}): string | undefined {
  const props = e.properties;
  if (e.type === "session.deleted") return props?.info?.id ?? props?.sessionID;
  if (e.type === "message.part.updated") return props?.part?.sessionID ?? props?.sessionID;
  if (e.type === "message.updated") return props?.info?.sessionID ?? props?.sessionID;
  return props?.sessionID;
}

export const ClmContextPlugin: Plugin = async ({ client }) => {
  const cfg = loadConfig();
  const enabled = resolveEnabled(cfg, process.env.OPENCODE_CLM);
  if (!enabled) return {};

  const budget =
    typeof cfg.budget_tokens === "number" && cfg.budget_tokens > 0
      ? cfg.budget_tokens
      : DEFAULT_BUDGET_TOKENS;

  const injected = new Set<string>();
  const mirrored = new Set<string>();
  const nudges = new Map<string, string[]>();
  const assistantParts = new Map<string, Map<string, string>>();

  const queueNudge = (sessionID: string, nudge: string): void => {
    if (!nudge) return;
    const list = nudges.get(sessionID) ?? [];
    list.push(nudge);
    nudges.set(sessionID, list);
  };

  const takeNudges = (sessionID: string): string[] => {
    const list = nudges.get(sessionID);
    if (!list || list.length === 0) return [];
    nudges.delete(sessionID);
    return list;
  };

  // sessionID is sanitized by liveContextFileName -> sanitizeSessionID, which
  // replaces every character outside [A-Za-z0-9._-] (including / and \\) with
  // "_"; the LIVE_CTX_ prefix and .txt suffix keep the result a single filename
  // component, so it cannot escape STATE_DIR.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const fileFor = (sessionID: string) => join(STATE_DIR, liveContextFileName(sessionID));

  const read = (sessionID: string): string => {
    try {
      return readFileSync(fileFor(sessionID), "utf-8");
    } catch {
      return "";
    }
  };

  const write = (sessionID: string, text: string): void => {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(fileFor(sessionID), text);
    } catch (err) {
      console.error("[clm-context] write failed", err);
    }
  };

  return {
    // Mirror user turns via chat.message (fires for user messages only).
    // Dedup by message id so re-delivery does not double-append.
    "chat.message": async (input, output) => {
      try {
        const sessionID = input.sessionID;
        if (!sessionID) return;
        const role = (output.message as { role?: string } | undefined)?.role;
        if (role !== "user") return;
        const messageID = input.messageID ?? (output.message as { id?: string })?.id ?? "";
        const key = `${sessionID}:${messageID}`;
        if (messageID && mirrored.has(key)) return;
        const text = textFromParts(output.parts);
        if (!text.trim()) return;
        if (messageID) mirrored.add(key);
        const appended = appendTurn(read(sessionID), role as ClmRole, text);
        const enforced = enforceBudget(appended, budget);
        write(sessionID, enforced.content);
        if (enforced.nudge) {
          console.info(`[clm-context] ${enforced.nudge}`);
          queueNudge(sessionID, enforced.nudge);
        }
      } catch (err) {
        console.error("[clm-context] chat.message mirror failed", err);
      }
    },

    // One-shot: surface the authored context to the model at session start.
    "experimental.chat.system.transform": async (input, output) => {
      try {
        const sessionID = input.sessionID;
        if (!sessionID) return;
        const pending = takeNudges(sessionID);
        if (!injected.has(sessionID)) {
          const current = read(sessionID);
          if (current.trim()) {
            const enforced = enforceBudget(current, budget);
            if (enforced.nudge) pending.push(enforced.nudge);
            if (enforced.tokens <= effectiveBudget(budget)) {
              injected.add(sessionID);
              output.system.push(
                [
                  "# CLM live context (self-managed)",
                  "You own the context file below. Read it with `context_edit` (action: read) and rewrite it with `context_edit` (action: replace).",
                  "The edit gate accepts a rewrite only if it fits the effective token budget or strictly shrinks the file; otherwise it is rejected with a one-line reason.",
                  ...(pending.length ? ["", ...pending] : []),
                  "",
                  enforced.content.trimEnd(),
                ].join("\n"),
              );
              return;
            }
          }
        }
        if (pending.length) output.system.push(pending.join("\n"));
      } catch (err) {
        console.error("[clm-context] system.transform inject failed", err);
      }
    },

    // Replace the built-in summarizer prompt. When the mirror is within budget,
    // embed it verbatim (bounded mode). When unbounded, instruct the summarizer
    // to condense into a fresh bounded context (re-seed mode) — the summary is
    // then fetched on session.compacted and written back to the mirror file.
    // dcp does not use this hook, and built-in compaction still runs its hidden
    // summarizer agent — see the README coexistence contract.
    "experimental.session.compacting": async (input, output) => {
      try {
        const sessionID = input.sessionID;
        if (!sessionID) return;
        const current = read(sessionID);
        if (!current.trim()) return;
        const enforced = enforceBudget(current, budget);
        if (enforced.tokens <= effectiveBudget(budget)) {
          output.prompt = buildCompactionPrompt(enforced.content, budget);
        } else {
          output.prompt = buildCompactionPrompt(undefined, budget);
        }
      } catch (err) {
        console.error("[clm-context] compacting hook failed", err);
      }
    },

    event: async ({ event }) => {
      try {
        const e = event as {
          type?: string;
          properties?: {
            sessionID?: string;
            info?: { id?: string; sessionID?: string; role?: string; summary?: boolean; time?: { completed?: number } };
            part?: { id?: string; sessionID?: string; messageID?: string; type?: string; text?: string; time?: { end?: number } };
          };
        };
        const sid = sessionIdFromEvent(e);
        if (e?.type === "session.deleted") {
          if (sid) {
            injected.delete(sid);
            nudges.delete(sid);
            const prefix = `${sid}:`;
            for (const key of mirrored) {
              if (key.startsWith(prefix)) mirrored.delete(key);
            }
            for (const key of assistantParts.keys()) {
              if (key.startsWith(prefix)) assistantParts.delete(key);
            }
          }
          return;
        }
        if (e?.type === "session.compacted") {
          if (!sid) return;
          const result = await client.session.messages({ path: { id: sid } });
          const messages = result.data ?? [];
          for (let i = messages.length - 1; i >= 0; i--) {
            const entry = messages[i];
            if ((entry.info as { summary?: boolean } | undefined)?.summary !== true) continue;
            const text = textFromParts(entry.parts);
            if (!text.trim()) return;
            const reseeded = reseedLiveContext(text, budget);
            if (reseeded.repaired) {
              console.warn(
                "[clm-context] compaction summary was not valid CLM; re-seeded as a bounded single turn",
              );
            }
            write(sid, reseeded.content);
            return;
          }
          return;
        }
        if (e?.type === "message.part.updated") {
          if (!sid) return;
          const part = e.properties?.part;
          if (!part || part.type !== "text" || part.time?.end === undefined) return;
          if (!part.text?.trim() || !part.id || !part.messageID) return;
          const buffer = assistantParts.get(`${sid}:${part.messageID}`);
          if (!buffer) return;
          buffer.set(part.id, part.text);
          return;
        }
        if (e?.type === "message.updated") {
          const info = e.properties?.info;
          const messageSid = info?.sessionID ?? sid;
          if (!messageSid || !info) return;
          const messageID = info.id;
          if (!messageID) return;
          const key = `${messageSid}:${messageID}`;
          if (info.role !== "assistant" || info.summary === true) {
            assistantParts.delete(key);
            return;
          }
          if (info.time?.completed === undefined) {
            if (!assistantParts.has(key)) assistantParts.set(key, new Map<string, string>());
            return;
          }
          const buffer = assistantParts.get(key);
          assistantParts.delete(key);
          const seen = `${messageSid}:msg:${messageID}`;
          if (mirrored.has(seen)) return;
          const text = buffer ? [...buffer.values()].join("\n") : "";
          if (!text.trim()) return;
          mirrored.add(seen);
          const appended = appendTurn(read(messageSid), "assistant", text);
          const enforced = enforceBudget(appended, budget);
          write(messageSid, enforced.content);
          if (enforced.nudge) {
            console.info(`[clm-context] ${enforced.nudge}`);
            queueNudge(messageSid, enforced.nudge);
          }
          return;
        }
      } catch (err) {
        console.error("[clm-context] event handler failed", err);
      }
    },

    tool: {
      context_edit: tool({
        description:
          "Read or rewrite this session's CLM live-context file. action=read returns the current file. " +
          "action=replace validates the full new content and, if accepted, overwrites the file. " +
          "An edit is accepted only if it fits the effective token budget or strictly shrinks the file; otherwise it is rejected with a one-line reason.",
        args: {
          action: tool.schema.enum(["read", "replace"]),
          content: tool.schema
            .string()
            .optional()
            .describe("Full new file content (required when action=replace)"),
        },
        execute: async (args, ctx) => {
          const sessionID = ctx.sessionID;
          const pending = takeNudges(sessionID);
          const withNudges = (reply: string) =>
            pending.length ? [...pending, reply].join("\n") : reply;
          try {
            const current = read(sessionID);
            if (args.action === "read") {
              return withNudges(current.trim() ? current : "(live context is empty)");
            }
            if (typeof args.content !== "string") {
              return withNudges("context_edit: rejected — action=replace requires content");
            }
            const decision = evaluateEdit(current, args.content, budget);
            if (decision.accepted) write(sessionID, args.content);
            return withNudges(decision.receipt);
          } catch (err) {
            console.error("[clm-context] context_edit failed", err);
            return withNudges("context_edit: rejected — internal error (see logs)");
          }
        },
      }),
    },
  };
};
