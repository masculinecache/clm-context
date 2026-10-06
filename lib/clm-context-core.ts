/**
 * Pure, side-effect-free logic for the CLM (Context Language Models)
 * self-managed context plugin.
 *
 * CLM treats the model's context as a live, model-editable file: the harness
 * supplies the mechanics (a per-session file, an edit tool with a fit/shrink
 * gate, and a compaction hook that replays the authored file verbatim). This
 * module holds the deterministic core — parsing, serialization, token-budget
 * accounting, the edit gate, and the compaction-prompt builder — so it can be
 * unit-tested without opencode.
 *
 * References:
 *   - facebookresearch/context-language-models
 *   - "Context Language Models" arXiv:2609.37725
 *
 * See ../README.md for the protocol and coexistence contract.
 */

export function stripJsonc(src: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && n === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\" && n) {
        out += n;
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export type ClmRole = "user" | "assistant" | "system";

export interface ClmMessage {
  role: ClmRole;
  content: string;
}

export interface ClmBudget {
  /** Estimated token count (chars / 4). */
  tokens: number;
  /** Number of message blocks. */
  blocks: number;
  /** Raw character count across all block contents. */
  chars: number;
}

export interface ClmParseOk {
  ok: true;
  messages: ClmMessage[];
}

export interface ClmParseErr {
  ok: false;
  error: string;
  /** 1-based line number the error was detected on. */
  line: number;
}

export type ClmParseResult = ClmParseOk | ClmParseErr;

export interface ClmEditDecision {
  accepted: boolean;
  /** One-line reason; empty string when accepted. */
  reason: string;
  /** One-line receipt, always present. */
  receipt: string;
  before: ClmBudget;
  after: ClmBudget;
  /** Effective token budget the decision was evaluated against. */
  budget: number;
}

export interface ClmConfig {
  enabled?: boolean;
  budget_tokens?: number;
}

export interface ClmEnforceResult {
  /** The (possibly trimmed) serialized file content. */
  content: string;
  /** True when turns were rolled back to fit the budget. */
  trimmed: boolean;
  /** Number of turns removed. */
  removed: number;
  /** One-line nudge for the model when trimmed; empty otherwise. */
  nudge: string;
  /** Token count after enforcement. */
  tokens: number;
}

export interface ClmReseedResult {
  /** A valid live-context file content. */
  content: string;
  /** True when the input did not parse and had to be repaired. */
  repaired: boolean;
}

/** Opening marker of a context block: `@@TURN <role> <n>`. */
export const TURN_OPEN = "@@TURN";
/** Closing marker of a context block. */
export const TURN_CLOSE = "@@END";
/** Default token budget for a live-context file. */
export const DEFAULT_BUDGET_TOKENS = 8000;
/** Headroom reserved from the budget so enforcement can roll back turns. */
export const DEFAULT_BUDGET_RESERVE = 2048;

const ROLES: ReadonlySet<string> = new Set(["user", "assistant", "system"]);

/**
 * The token cap actually enforced on the live-context file: the configured
 * budget minus the reserved headroom, floored at zero. The edit gate and
 * enforcement both use this, so content the gate accepts as fitting is never
 * trimmed later.
 */
export function effectiveBudget(
  budget: number = DEFAULT_BUDGET_TOKENS,
  reserve: number = DEFAULT_BUDGET_RESERVE,
): number {
  return Math.max(0, budget - reserve);
}

/**
 * Rough token estimate: ~4 characters per token. Deliberately simple and
 * deterministic so the gate is reproducible; CLM budgets are order-of-magnitude,
 * not exact tokenizer counts.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil([...text].length / 4);
}

export function computeBudget(messages: ClmMessage[]): ClmBudget {
  let chars = 0;
  for (const m of messages) chars += [...m.content].length;
  const joined = messages.map((m) => m.content).join("\n");
  return { tokens: estimateTokens(joined), blocks: messages.length, chars };
}

const ESCAPE = "\\";

function escapeContentLine(line: string): string {
  if (line.trim() === TURN_CLOSE || line.startsWith(ESCAPE)) return ESCAPE + line;
  return line;
}

function unescapeContentLine(line: string): string {
  if (!line.startsWith(ESCAPE)) return line;
  const rest = line.slice(1);
  if (rest.trim() === TURN_CLOSE || rest.startsWith(ESCAPE)) return rest;
  return line;
}

/** Render messages into the live-context file format. */
export function serializeLiveContext(messages: ClmMessage[]): string {
  const parts: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    parts.push(`${TURN_OPEN} ${m.role} ${i + 1}`);
    parts.push(m.content.split("\n").map(escapeContentLine).join("\n"));
    parts.push(TURN_CLOSE);
    parts.push("");
  }
  return parts.join("\n");
}

/**
 * Parse the live-context file back into a well-formed message structure.
 *
 * Format: one `@@TURN <role> <n>` header, arbitrary content lines, then
 * `@@END`. Blank lines and `#` comments are allowed outside blocks. Content
 * lines that would otherwise be read as a terminator (or that start with the
 * escape character) are escaped with a leading backslash on write and reversed
 * here, so any turn text round-trips without terminating the block early.
 */
export function parseLiveContext(text: string): ClmParseResult {
  const lines = text.split("\n");
  const messages: ClmMessage[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    if (!trimmed.startsWith(TURN_OPEN)) {
      return {
        ok: false,
        error: `unexpected content outside a ${TURN_OPEN} block`,
        line: i + 1,
      };
    }
    const header = trimmed.slice(TURN_OPEN.length).trim();
    const role = header.split(/\s+/)[0] ?? "";
    if (!ROLES.has(role)) {
      return {
        ok: false,
        error: `invalid or missing role (expected user|assistant|system)`,
        line: i + 1,
      };
    }
    i++;
    const content: string[] = [];
    let closed = false;
    while (i < lines.length) {
      if (lines[i].trim() === TURN_CLOSE) {
        closed = true;
        i++;
        break;
      }
      content.push(unescapeContentLine(lines[i]));
      i++;
    }
    if (!closed) {
      return {
        ok: false,
        error: `missing ${TURN_CLOSE} for ${TURN_OPEN} ${role}`,
        line: i,
      };
    }
    while (content.length && content[0].trim() === "") content.shift();
    while (content.length && content[content.length - 1].trim() === "") content.pop();
    messages.push({ role: role as ClmRole, content: content.join("\n") });
  }
  return { ok: true, messages };
}

function safeParse(text: string): ClmMessage[] {
  const parsed = parseLiveContext(text);
  return parsed.ok ? parsed.messages : [];
}

/** Append one turn and re-serialize. Invalid prior content is treated as empty. */
export function appendTurn(text: string, role: ClmRole, content: string): string {
  const messages = safeParse(text);
  messages.push({ role, content });
  return serializeLiveContext(messages);
}

/**
 * Turn a compaction summary into a valid live-context file. A well-formed
 * summary is kept as authored; an unparsable one is preserved as a single
 * bounded `system` turn so a misbehaving summarizer can neither corrupt the
 * mirror nor cause an unbounded raw file to be injected.
 */
export function reseedLiveContext(
  text: string,
  budget: number = DEFAULT_BUDGET_TOKENS,
  reserve: number = DEFAULT_BUDGET_RESERVE,
): ClmReseedResult {
  if (parseLiveContext(text).ok) return { content: text, repaired: false };
  const capped = [...text].slice(0, Math.max(0, effectiveBudget(budget, reserve) * 4)).join("");
  return {
    content: serializeLiveContext([{ role: "system", content: capped }]),
    repaired: true,
  };
}

/**
 * Enforce the token budget on the live-context file. When the file exceeds
 * the budget, roll back newest turns until at least `reserve` tokens are free
 * (or only one turn remains). Returns the trimmed content plus a nudge message
 * telling the model to condense. Bounded: never removes the last remaining
 * turn, so the file always has at least one block.
 */
export function enforceBudget(
  text: string,
  budget: number = DEFAULT_BUDGET_TOKENS,
  reserve: number = DEFAULT_BUDGET_RESERVE,
): ClmEnforceResult {
  const parsed = parseLiveContext(text);
  if (!parsed.ok) {
    // Unparsable content cannot be trimmed by turn. Report its real size so
    // callers never mistake a raw, unbounded file for an empty context.
    return { content: text, trimmed: false, removed: 0, nudge: "", tokens: estimateTokens(text) };
  }
  const messages = parsed.messages;
  if (messages.length === 0) {
    return { content: text, trimmed: false, removed: 0, nudge: "", tokens: 0 };
  }
  const cap = effectiveBudget(budget, reserve);
  let current = messages.slice();
  let removed = 0;
  while (current.length > 1) {
    const tokens = estimateTokens(current.map((m) => m.content).join("\n"));
    if (tokens <= cap) break;
    current.pop();
    removed++;
  }
  const tokens = estimateTokens(current.map((m) => m.content).join("\n"));
  const trimmed = removed > 0;
  const content = serializeLiveContext(current);
  const nudge = trimmed
    ? `CLM budget enforcement: removed ${removed} newest turn(s) to stay within the ${cap}-token budget. Condense older turns with context_edit to free space.`
    : "";
  return { content, trimmed, removed, nudge, tokens };
}

/**
 * The edit gate. An edit is accepted when it parses AND either fits the
 * effective token budget or strictly shrinks the file. Everything else is
 * rejected with a one-line reason. A one-line receipt is always produced.
 */
export function evaluateEdit(
  previous: string,
  edited: string,
  budget: number = DEFAULT_BUDGET_TOKENS,
  reserve: number = DEFAULT_BUDGET_RESERVE,
): ClmEditDecision {
  const cap = effectiveBudget(budget, reserve);
  const before = computeBudget(safeParse(previous));
  const parsed = parseLiveContext(edited);
  if (!parsed.ok) {
    const reason = `parse error (line ${parsed.line}): ${parsed.error}`;
    return {
      accepted: false,
      reason,
      receipt: `context_edit: rejected — ${reason}`,
      before,
      after: before,
      budget: cap,
    };
  }
  const after = computeBudget(parsed.messages);
  const delta = `blocks ${before.blocks}->${after.blocks} tokens ${before.tokens}->${after.tokens} budget ${cap}`;
  if (after.tokens <= cap) {
    return {
      accepted: true,
      reason: "",
      receipt: `context_edit: accepted (fits) ${delta}`,
      before,
      after,
      budget: cap,
    };
  }
  if (after.tokens < before.tokens) {
    return {
      accepted: true,
      reason: "",
      receipt: `context_edit: accepted (shrink) ${delta}`,
      before,
      after,
      budget: cap,
    };
  }
  const reason = `over budget (${after.tokens} > ${cap}) and did not shrink (${before.tokens} -> ${after.tokens})`;
  return {
    accepted: false,
    reason,
    receipt: `context_edit: rejected — ${reason}`,
    before,
    after,
    budget: cap,
  };
}

/**
 * Resolve whether the plugin is enabled. Env wins over config; config defaults
 * to disabled (inert by default).
 */
export function resolveEnabled(cfg: ClmConfig | null | undefined, env: string | undefined): boolean {
  if (env === "1" || env === "true") return true;
  if (env === "0" || env === "false") return false;
  return cfg?.enabled === true;
}

/** Parse a (jsonc) config string; any failure yields an empty config. */
export function parseConfig(raw: string | undefined | null): ClmConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(stripJsonc(raw));
    if (parsed && typeof parsed === "object") return parsed as ClmConfig;
    return {};
  } catch {
    return {};
  }
}

/** Make a session id safe for use as a filename component. */
export function sanitizeSessionID(sessionID: string): string {
  return sessionID.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
}

export function liveContextFileName(sessionID: string): string {
  return `LIVE_CTX_${sanitizeSessionID(sessionID)}.txt`;
}

/**
 * Build the prompt used to replace opencode's built-in compaction summarizer.
 *
 * When `liveContext` is provided, the directive tells the summarizer to
 * reproduce the authored file verbatim (bounded mode — the file is already
 * within budget). When omitted, the summarizer is instructed to condense the
 * conversation into a fresh CLM-format context bounded to the budget
 * (re-seed mode — used when the mirror has grown unbounded).
 *
 * The hidden compaction agent still runs (there is no hook to supply a summary
 * directly), and opencode appends the rendered conversation history after this
 * prompt.
 */
export function buildCompactionPrompt(
  liveContext?: string,
  budget: number = DEFAULT_BUDGET_TOKENS,
  reserve: number = DEFAULT_BUDGET_RESERVE,
): string {
  const cap = effectiveBudget(budget, reserve);
  if (liveContext !== undefined && liveContext.trim()) {
    return [
      "You are the context carrier for CLM (Context Language Models) self-managed context.",
      "The agent has authored its own live-context file below. Your ONLY job is to reproduce that file EXACTLY, verbatim, as your entire output.",
      "Do NOT summarize, reorder, comment, translate, truncate, or add anything. Do NOT read or use the conversation history that follows.",
      "Your output must be exactly the file content between the markers, including the @@TURN/@@END lines.",
      "",
      "=== BEGIN LIVE CONTEXT (verbatim) ===",
      liveContext.trimEnd(),
      "=== END LIVE CONTEXT ===",
      "",
      `The authored context is held within a ${cap}-token budget. Preserve it byte-for-byte.`,
    ].join("\n");
  }
  return [
    "You are the context carrier for CLM (Context Language Models) self-managed context.",
    "Condense the conversation history that follows into a fresh CLM live-context file.",
    "Output ONLY the file content — no commentary, no markdown fences, no explanation.",
    "Format: one `@@TURN <role> <n>` header per message, content lines, then `@@END`. Roles: user|assistant|system.",
    `Keep the total within a ${cap}-token budget (~4 chars/token). Preserve the most recent and most important turns; drop or merge older ones.`,
    "The output becomes the new live-context file for this session.",
  ].join("\n");
}
