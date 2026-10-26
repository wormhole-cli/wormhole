import { z } from 'zod';

export const TOOLS = ['claude', 'codex', 'opencode'] as const;
export const Tool = z.enum(TOOLS);
export type Tool = z.infer<typeof Tool>;

/**
 * Neutral transcript event. Reasoning is never carried across tools: Claude
 * thinking signatures and Codex encrypted_content only verify with their own
 * provider, so readers drop them.
 */
export const Event = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user_text'), text: z.string(), ts: z.string().optional() }),
  z.object({ kind: z.literal('assistant_text'), text: z.string(), ts: z.string().optional() }),
  z.object({
    kind: z.literal('tool_call'),
    callId: z.string(),
    name: z.string(),
    inputSummary: z.string(),
    ts: z.string().optional(),
  }),
  z.object({
    kind: z.literal('tool_result'),
    callId: z.string(),
    summary: z.string(),
    isError: z.boolean().default(false),
    ts: z.string().optional(),
  }),
  z.object({
    kind: z.literal('file_change'),
    path: z.string(),
    op: z.enum(['create', 'edit', 'delete']),
    ts: z.string().optional(),
  }),
  z.object({ kind: z.literal('compact_summary'), text: z.string(), ts: z.string().optional() }),
]);
export type Event = z.infer<typeof Event>;

/** One native session in one tool. */
export const Segment = z.object({
  tool: Tool,
  nativeId: z.string(),
  path: z.string(),
  startedAt: z.string(),
  /** Byte offset into the native file already imported into the thread. */
  importedUpTo: z.number().int().nonnegative().default(0),
  /** Index in thread events where this segment's own events begin. */
  eventStart: z.number().int().nonnegative(),
  /** Set when wormhole synthesized this segment from another tool's history. */
  derivedFrom: z.object({ tool: Tool, nativeId: z.string() }).optional(),
});
export type Segment = z.infer<typeof Segment>;

/** One workstream in one project directory, spanning any number of tools. */
export const Thread = z.object({
  version: z.literal(1),
  id: z.string(),
  cwd: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  segments: z.array(Segment),
});
export type Thread = z.infer<typeof Thread>;

export function activeSegment(thread: Thread): Segment | undefined {
  return thread.segments.at(-1);
}
