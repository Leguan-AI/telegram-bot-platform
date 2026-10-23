/**
 * Shared shapes for the repository tools (#21 §5, §6).
 *
 * Separate from the implementation so the tool definitions sent to a model, the session
 * that executes them, and the tests can agree without importing GitHub plumbing.
 */

/** A repository in scope for this answer, as lib/repoScope resolved it. */
export interface ScopedRepoRef {
  repoId: number;
  /** `owner/name`, used for GitHub URLs and for the model-facing enum. */
  fullName: string;
  /** v1 follows the default branch only (§6). */
  defaultBranch: string;
}

/**
 * What a tool hands back to the loop. `isError` maps to the provider's error flag; the
 * text is what the model sees, and never contains GitHub's own error bodies.
 */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** One file actually read, for the server-built provenance footer (§9). */
export interface ReadRecord {
  repoFullName: string;
  path: string;
}

export const TOOL_NAMES = ['list_tree', 'read_file', 'search_code'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Limits from §6. Overridable per session so tests do not have to build huge fixtures. */
export interface RepoToolLimits {
  /** Bytes of file content returned for a single read before truncation. */
  maxFileBytes: number;
  /** Total bytes of repository content across every tool call in one answer. */
  maxAnswerBytes: number;
  /** Entries in one list_tree reply before the "…N more" marker. */
  maxTreeEntries: number;
  /** Deepest `depth` a list_tree call may ask for. */
  maxTreeDepth: number;
  /** Search hits returned. */
  maxSearchResults: number;
}

export const DEFAULT_LIMITS: RepoToolLimits = {
  maxFileBytes: 64 * 1024,
  maxAnswerBytes: 256 * 1024,
  maxTreeEntries: 200,
  maxTreeDepth: 3,
  maxSearchResults: 20,
};

/**
 * GitHub's two rate-limit buckets behave differently (search is ~10/minute, REST is
 * 5,000/hour per installation), and §7 short-circuits them separately: once one is
 * exhausted inside an answer, further calls in that bucket return the same error without
 * contacting GitHub, so a retrying model cannot burn the installation's quota.
 */
export type RateBucket = 'search' | 'rest';
