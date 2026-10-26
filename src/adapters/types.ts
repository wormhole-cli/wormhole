import type { Event, Tool } from '../model/thread.js';

export interface NativeRef {
  tool: Tool;
  /** Set by core for sessions of a named account; adapters leave it alone. */
  account?: string;
  nativeId: string;
  path: string;
  startedAt: string;
  /** Last modification of the native file; used to pick the session in use. */
  updatedAt: string;
  /**
   * On a session wormhole just wrote: the read offset that covers what it wrote.
   * Defaults to the file size, which fits tools that keep one append-only file.
   */
  offset?: number;
}

export interface ReadResult {
  events: Event[];
  /** Byte offset reached; pass it back as fromOffset for an incremental read. */
  offset: number;
}

export interface WriteContext {
  cwd: string;
  gitBranch?: string;
  /** Appended as the final user turn so the target model reads it on resume. */
  brief?: string;
}

export interface ToolAdapter {
  tool: Tool;
  /** Named account this adapter reads and writes, when not the tool's default login. */
  account?: string;
  /** Environment that points the tool's CLI at this adapter's folder (set for named accounts). */
  env?: Record<string, string>;
  /** Newest native session for this project directory, if any. */
  detectLatest(cwd: string): Promise<NativeRef | null>;
  /** A specific native session of this project by id. */
  locate(cwd: string, nativeId: string): Promise<NativeRef | null>;
  /** Parse native transcript into neutral events, starting at a byte offset. */
  read(ref: NativeRef, fromOffset?: number): Promise<ReadResult>;
  /** Synthesize a new, resumable native session from neutral events. */
  write(events: Event[], ctx: WriteContext): Promise<NativeRef>;
  /**
   * Copy an existing native session under a new id and append events to the copy.
   * The original is never modified; the copy keeps its native tool calls intact.
   */
  extend(base: NativeRef, events: Event[], ctx: WriteContext): Promise<NativeRef>;
  /** argv that reopens the session interactively. */
  launchArgs(ref: NativeRef): string[];
  /** Link that opens the session in the tool's desktop app, if it has one. */
  appUrl?(ref: NativeRef): string;
}
