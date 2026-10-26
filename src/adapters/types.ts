import type { Event, Tool } from '../model/thread.js';

export interface NativeRef {
  tool: Tool;
  nativeId: string;
  path: string;
  startedAt: string;
  /** Last modification of the native file; used to pick the session in use. */
  updatedAt: string;
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
}
