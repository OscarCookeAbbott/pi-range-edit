import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { planEdits, type RangeEdit, type ResolvedRange } from "./ranges.ts";

export interface Config {
  maxLineShift: number;
  maxFileBytes: number;
  maxPendingEdits: number;
}
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ID_COUNT = ID_ALPHABET.length ** 2;
export const DEFAULT_CONFIG: Config = { maxLineShift: 20, maxFileBytes: 8 * 1024 * 1024, maxPendingEdits: 10 };
export function readConfig(settings: unknown): Config {
  const config = (settings as { rangeEdit?: unknown }).rangeEdit;
  if (config === undefined) return { ...DEFAULT_CONFIG };
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("rangeEdit settings must be a JSON object.");
  const values = config as Partial<Config>;
  const maxLineShift = values.maxLineShift === undefined ? DEFAULT_CONFIG.maxLineShift : values.maxLineShift;
  const maxFileBytes = values.maxFileBytes === undefined ? DEFAULT_CONFIG.maxFileBytes : values.maxFileBytes;
  const maxPendingEdits = values.maxPendingEdits === undefined ? DEFAULT_CONFIG.maxPendingEdits : values.maxPendingEdits;
  if (!Number.isSafeInteger(maxPendingEdits) || maxPendingEdits < 1 || maxPendingEdits > ID_COUNT) throw new Error(`rangeEdit.maxPendingEdits must be an integer between 1 and ${ID_COUNT}.`);
  if (!Number.isSafeInteger(maxLineShift) || maxLineShift < 0 || maxLineShift > 1000) throw new Error("rangeEdit.maxLineShift must be an integer between 0 and 1000.");
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new Error("rangeEdit.maxFileBytes must be a positive safe integer.");
  return { maxLineShift, maxFileBytes, maxPendingEdits };
}

export const digest = (content: Uint8Array | string): string => createHash("sha256").update(content).digest("hex");
export function absolutePath(path: string, cwd: string): string {
  if (typeof path !== "string" || !path.trim()) throw new Error("path is required.");
  return resolve(cwd, path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
}
export async function readTextFile(path: string, maxBytes: number): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("range_edit only supports existing regular files.");
  if (info.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte range_edit limit.`);
  const content = await readFile(path);
  if (content.length > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte range_edit limit.`);
  if (content.includes(0) || !Buffer.from(content.toString("utf8"), "utf8").equals(content)) throw new Error("range_edit requires UTF-8 text without NUL bytes.");
  return content;
}

interface Version {
  lastReadDigest?: string;
  expectedDigest: string;
  ownEdits: number;
}
export interface EditRequest {
  path: string;
  edits: RangeEdit[];
  maxLineShift?: number;
}
interface Proposal {
  id: string;
  path: string;
  requestedPath: string;
  edits: RangeEdit[];
  maxLineShift: number;
  baseDigest: string;
}
export interface EditResult {
  status: "applied" | "pending" | "unchanged";
  path: string;
  pendingId?: string;
  reason?: string;
  ownEdits: number;
  ranges: ResolvedRange[];
  before: string;
  after: string;
}
export type MutationQueue = <T>(path: string, operation: () => Promise<T>) => Promise<T>;

export class RangeEditor {
  private versions = new Map<string, Version>();
  private proposals = new Map<string, Proposal>();
  private nextProposalId = 0;
  private queue: MutationQueue;
  config: Config = { ...DEFAULT_CONFIG };
  generation = 0;

  constructor(queue: MutationQueue) {
    this.queue = queue;
  }

  reset(config = this.config): void {
    this.generation++;
    this.config = { ...config };
    this.versions.clear();
    this.proposals.clear();
    this.nextProposalId = 0;
  }

  recordRead(path: string, hash: string): void {
    this.versions.set(path, { lastReadDigest: hash, expectedDigest: hash, ownEdits: 0 });
  }

  recordKnownMutation(path: string, beforeDigest: string | undefined, afterDigest: string, completeWrite = false): void {
    const previous = this.versions.get(path);
    if (!completeWrite && (!previous || previous.expectedDigest !== beforeDigest)) return;
    this.versions.set(path, { lastReadDigest: previous?.lastReadDigest, expectedDigest: afterDigest, ownEdits: (previous?.ownEdits ?? 0) + 1 });
  }

  async edit(request: EditRequest, cwd: string, signal?: AbortSignal): Promise<EditResult> {
    const generation = this.generation;
    const requestedPath = absolutePath(request.path, cwd);
    const path = await realpath(requestedPath);
    const maxLineShift = request.maxLineShift ?? this.config.maxLineShift;
    if (!Number.isSafeInteger(maxLineShift) || maxLineShift < 0 || maxLineShift > this.config.maxLineShift) throw new Error(`maxLineShift must be between 0 and the configured limit of ${this.config.maxLineShift}.`);
    const proposal: Proposal = { id: "", path, requestedPath, edits: structuredClone(request.edits), maxLineShift, baseDigest: "" };
    return this.run(proposal, generation, signal);
  }

  async reapply(pendingId: string, signal?: AbortSignal): Promise<EditResult> {
    const proposal = this.proposals.get(pendingId);
    if (!proposal) throw new Error("Unknown, consumed, or expired pendingId. Read the file and submit a new edit.");
    return this.run(proposal, this.generation, signal);
  }

  private async run(proposal: Proposal, generation: number, signal?: AbortSignal): Promise<EditResult> {
    const check = (): void => {
      if (signal?.aborted) throw new Error("Operation aborted before writing.");
      if (generation !== this.generation) throw new Error("Session changed before writing; submit the edit again.");
    };
    return this.queue(proposal.path, async () => {
      check();
      if (proposal.id && this.proposals.get(proposal.id) !== proposal) throw new Error("Pending edit has already been consumed or expired.");
      if (await realpath(proposal.requestedPath) !== proposal.path) throw new Error("File target changed; read it and submit a new edit. Nothing written.");
      const buffer = await readTextFile(proposal.path, this.config.maxFileBytes);
      check();
      const before = buffer.toString("utf8");
      const hash = digest(buffer);
      const plan = planEdits(before, proposal.edits, proposal.maxLineShift);
      if (Buffer.byteLength(plan.content, "utf8") > this.config.maxFileBytes) throw new Error("Replacement exceeds the configured file-size limit. Nothing written.");
      if (plan.content.includes("\0") || !plan.content.isWellFormed()) throw new Error("Replacement requires UTF-8 text without NUL bytes. Nothing written.");
      const version = this.versions.get(proposal.path);
      const acknowledged = proposal.id !== "" && proposal.baseDigest === hash;
      let reason: string | undefined;
      if (proposal.id && !acknowledged) reason = "File changed again since the pending proposal. This version needs a new acknowledgement.";
      else if (!acknowledged && !version) reason = "No recorded read or write version for this file. Read it or acknowledge this proposal.";
      else if (!acknowledged && version?.expectedDigest !== hash) reason = "File has unaccounted-for changes outside recorded tool edits.";
      const result = { path: proposal.requestedPath, ownEdits: version?.ownEdits ?? 0, ranges: plan.ranges, before, after: plan.content };
      if (reason) {
        if (proposal.id) this.proposals.delete(proposal.id);
        while (this.proposals.size >= this.config.maxPendingEdits) this.proposals.delete(this.proposals.keys().next().value!);
        let id: string;
        do {
          const value = this.nextProposalId;
          this.nextProposalId = (value + 1) % ID_COUNT;
          id = ID_ALPHABET[Math.floor(value / ID_ALPHABET.length)] + ID_ALPHABET[value % ID_ALPHABET.length];
        } while (this.proposals.has(id));
        // Pending proposals retain edit instructions and digests, never file snapshots.
        this.proposals.set(id, { ...proposal, id, baseDigest: hash });
        return { ...result, status: "pending", pendingId: id, reason };
      }
      if (before === plan.content) {
        if (proposal.id) {
          this.proposals.delete(proposal.id);
          this.versions.set(proposal.path, { lastReadDigest: version?.lastReadDigest, expectedDigest: hash, ownEdits: 0 });
        }
        return { ...result, status: "unchanged" };
      }
      // Protect against changes while planning, including symlink retargeting. There is no OS-level CAS.
      const current = await readTextFile(proposal.path, this.config.maxFileBytes);
      if (digest(current) !== hash || await realpath(proposal.requestedPath) !== proposal.path) throw new Error("File changed while preparing the edit. Nothing written; submit again.");
      check();
      await writeFile(proposal.path, plan.content, "utf8");
      // Once writeFile succeeds, report the applied edit even if cancellation arrives afterwards.
      if (generation === this.generation) {
        this.versions.set(proposal.path, { lastReadDigest: version?.lastReadDigest, expectedDigest: digest(plan.content), ownEdits: acknowledged ? 1 : (version?.ownEdits ?? 0) + 1 });
        for (const [id, pending] of this.proposals) if (pending.path === proposal.path) this.proposals.delete(id);
      }
      return { ...result, status: "applied" };
    });
  }
}
