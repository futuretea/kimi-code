import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { ZipFile } from 'yazl';

export interface SkillArchiveFixture {
  readonly descriptor: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
		readonly origin: 'managed' | 'forward';
    readonly content_size: number;
    readonly content_sha256: string;
  };
  readonly path: string;
  readonly blob: Blob;
}

export async function writeSkillArchive(
  directory: string,
  options: {
    readonly id?: string;
    readonly name: string;
    readonly version?: string;
		readonly origin?: 'managed' | 'forward';
    readonly files?: Readonly<Record<string, string>>;
  },
): Promise<SkillArchiveFixture> {
  const path = join(directory, `${options.name}-${Date.now()}.zip`);
  const zip = new ZipFile();
  const files = options.files ?? {
    'SKILL.md': `---\nname: ${options.name}\ndescription: Test skill\n---\n`,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    zip.addBuffer(Buffer.from(content, 'utf8'), `${options.name}/${relativePath}`);
  }
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  const complete = pipeline(zip.outputStream, output);
  zip.end();
  await complete;
  const contents = await readFile(path);
  return {
    descriptor: {
      id: options.id ?? 'skill_1',
      name: options.name,
      version: options.version ?? '2',
		origin: options.origin ?? 'managed',
      content_size: contents.byteLength,
      content_sha256: createHash('sha256').update(contents).digest('hex'),
    },
    path,
    blob: new Blob([contents], { type: 'application/zip' }),
  };
}
