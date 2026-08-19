import { createHash, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FastifyRequest } from 'fastify';

import { FacadeError } from './errors';
import type { FacadeSkillArchive, FacadeSkillOrigin } from './facade-types';

export const MAX_SESSION_CONFIG_BYTES = 1 * 1024 * 1024;
export const MAX_SESSION_SKILLS = 20;
export const MANAGED_SKILL_ARCHIVE_BYTES = 50_000_000;
export const MAX_SKILL_ARCHIVE_BYTES = 50 * 1024 * 1024;

interface SkillDescriptor {
	readonly origin: FacadeSkillOrigin;
	readonly content_size: number;
  readonly content_sha256: string;
}

interface SessionCreateBodyWithSkills {
  readonly skills?: readonly SkillDescriptor[];
}

export interface ParsedSessionCreate<T extends SessionCreateBodyWithSkills> {
  readonly body: T;
  readonly archives: readonly FacadeSkillArchive[];
  dispose(): Promise<void>;
}

/**
 * Parses the one internal, streaming session-create envelope. A JSON `config`
 * field must be first; each following `skill` file is paired by index with
 * that config's immutable Skill descriptor. Files are staged to a private
 * temporary directory rather than buffered in process memory.
 */
export async function parseSessionCreateMultipart<T extends SessionCreateBodyWithSkills>(
  request: FastifyRequest,
  parseConfig: (raw: unknown) => T,
): Promise<ParsedSessionCreate<T>> {
  if (!request.isMultipart()) throw new FacadeError('invalid_request');

  let temporaryDirectory: string | undefined;
  let parsedBody: T | undefined;
  const archives: FacadeSkillArchive[] = [];
  let partCount = 0;

  try {
    for await (const part of request.parts()) {
      partCount += 1;
      if (parsedBody === undefined) {
        if (part.type !== 'field' || part.fieldname !== 'config') {
          if (part.type === 'file') part.file.resume();
          throw new FacadeError('invalid_request');
        }
        if (part.valueTruncated || Buffer.byteLength(String(part.value), 'utf8') > MAX_SESSION_CONFIG_BYTES) {
          throw new FacadeError('request_too_large');
        }
        parsedBody = parseConfig(parseJsonConfig(part.value));
        const expectedSkills = parsedBody.skills ?? [];
        if (expectedSkills.length > MAX_SESSION_SKILLS) throw new FacadeError('invalid_request');
        if (expectedSkills.length > 0) {
          temporaryDirectory = await mkdtemp(join(tmpdir(), 'oca-session-skills-'));
        }
        continue;
      }

      if (part.type !== 'file' || part.fieldname !== 'skill') {
        if (part.type === 'file') part.file.resume();
        throw new FacadeError('invalid_request');
      }
      const expectedSkills = parsedBody.skills ?? [];
      const descriptor = expectedSkills[archives.length];
      if (descriptor === undefined || temporaryDirectory === undefined) {
        part.file.resume();
        throw new FacadeError('invalid_request');
      }
      const archive = await stageSkillArchive(part.file, temporaryDirectory, archives.length, descriptor);
      archives.push(archive);
    }

    if (partCount === 0 || parsedBody === undefined || archives.length !== (parsedBody.skills ?? []).length) {
      throw new FacadeError('invalid_request');
    }
    return {
      body: parsedBody,
      archives,
      dispose: async () => {
        if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
    if (error instanceof FacadeError) throw error;
    const statusCode = (error as { statusCode?: number }).statusCode;
    throw new FacadeError(statusCode === 413 ? 'request_too_large' : 'invalid_request');
  }
}

function parseJsonConfig(value: unknown): unknown {
  if (typeof value !== 'string') throw new FacadeError('invalid_request');
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new FacadeError('invalid_request');
  }
}

async function stageSkillArchive(
  input: NodeJS.ReadableStream & { readonly truncated: boolean },
  temporaryDirectory: string,
  index: number,
  descriptor: SkillDescriptor,
): Promise<FacadeSkillArchive> {
  const path = join(temporaryDirectory, `${index}.zip`);
  let size = 0;
  const digest = createHash('sha256');
  const sizeAndHash = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(input, sizeAndHash, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
	const maxArchiveBytes = skillArchiveByteLimit(descriptor.origin);
  if (input.truncated || size > maxArchiveBytes || descriptor.content_size > maxArchiveBytes) {
    throw new FacadeError('request_too_large');
  }
  if (size !== descriptor.content_size || !matchesSHA256(digest.digest('hex'), descriptor.content_sha256)) {
    throw new FacadeError('invalid_request');
  }
  return { path };
}

function skillArchiveByteLimit(origin: FacadeSkillOrigin): number {
	return origin === 'managed' ? MANAGED_SKILL_ARCHIVE_BYTES : MAX_SKILL_ARCHIVE_BYTES;
}

function matchesSHA256(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
