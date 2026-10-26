import { z } from 'zod';

export const TOOLS = ['claude', 'codex', 'opencode'] as const;
export const Tool = z.enum(TOOLS);
export type Tool = z.infer<typeof Tool>;

/** Fields every event carries. `src` names the native session it was imported from ("tool:id"). */
const meta = { ts: z.string().optional(), src: z.string().optional() };

/**
 * Set when the text was cut to fit the store: names the file in the thread's
 * `artifacts/` directory that holds it in full.
 */
const artifact = z.string().optional();

/**
 * Neutral transcript event. Reasoning is never carried across tools: Claude
 * thinking signatures and Codex encrypted_content only verify with their own
 * provider, so readers drop them.
 */
export const Event = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user_text'), text: z.string(), ...meta }),
  z.object({ kind: z.literal('assistant_text'), text: z.string(), ...meta }),
  z.object({
    kind: z.literal('tool_call'),
    callId: z.string(),
    name: z.string(),
    inputSummary: z.string(),
    artifact,
    ...meta,
  }),
  z.object({
    kind: z.literal('tool_result'),
    callId: z.string(),
    summary: z.string(),
    isError: z.boolean().default(false),
    artifact,
    ...meta,
  }),
  z.object({
    kind: z.literal('file_change'),
    path: z.string(),
    op: z.enum(['create', 'edit', 'delete']),
    ...meta,
  }),
  z.object({ kind: z.literal('compact_summary'), text: z.string(), ...meta }),
]);
export type Event = z.infer<typeof Event>;

/** One native session in one tool. */
export const Segment = z.object({
  tool: Tool,
  /** Named account (see accounts.json) when not the tool's default login. */
  account: z.string().optional(),
  nativeId: z.string(),
  path: z.string(),
  startedAt: z.string(),
  /** Byte offset into the native file already imported into the thread. */
  importedUpTo: z.number().int().nonnegative().default(0),
  /**
   * Index in thread events where this segment's own events begin. For a segment
   * wormhole wrote, its file already holds every thread event before this index.
   */
  eventStart: z.number().int().nonnegative(),
  /** Set when wormhole wrote this segment as a handoff from another tool. */
  derivedFrom: z.object({ tool: Tool, account: z.string().optional(), nativeId: z.string() }).optional(),
});
export type Segment = z.infer<typeof Segment>;

export function srcKey(seg: { tool: Tool; nativeId: string }): string {
  return `${seg.tool}:${seg.nativeId}`;
}

/**
 * The tool an event came from: its `src`, or for events recorded before source
 * tagging, the segment whose range it falls in.
 */
export function eventTool(e: Event, index: number, segments: Segment[]): Tool | undefined {
  const tagged = Tool.safeParse(e.src?.split(':')[0]);
  if (tagged.success) return tagged.data;
  return segments.findLast((s) => s.eventStart <= index)?.tool;
}

const SessionKey = z.object({ tool: Tool, account: z.string().optional(), nativeId: z.string() });

/**
 * Set by a switch made because the session in use hit its usage limit (`wormhole next`, or the
 * hooks with `accounts auto on`); cleared by the next switch. Shown by resume and status until
 * the session it wrote gets turns of its own.
 */
export const Fallback = z.object({
  from: SessionKey,
  to: SessionKey,
  /** When the limit was hit, and when it lifts, as the tool reported them. */
  limitedAt: z.string().optional(),
  resetsAt: z.string().optional(),
  reason: z.string(),
  /** Read offset of `to` when it was written: past it, the session has been used. */
  offset: z.number().int().nonnegative(),
});
export type Fallback = z.infer<typeof Fallback>;

/** One workstream in one project directory, spanning any number of tools. */
export const Thread = z.object({
  version: z.literal(1),
  id: z.string(),
  cwd: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  segments: z.array(Segment),
  fallback: Fallback.optional(),
});
export type Thread = z.infer<typeof Thread>;

export function activeSegment(thread: Thread): Segment | undefined {
  return thread.segments.at(-1);
}
