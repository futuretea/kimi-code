import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureConfigFile } from '../../node-sdk/src/config/toml.js';
import { DEFAULT_TUI_CONFIG, renderTuiConfig } from '../../../apps/kimi-code/src/tui/config.js';
import {
  DEFAULT_CONFIG_FILE_TEXT,
  isConfigStubOrMissing,
  isTuiStubOrMissing,
} from '../src/stub-detect.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stub-detect-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('isConfigStubOrMissing', () => {
  it('returns true when config.toml is missing', async () => {
    expect(await isConfigStubOrMissing(join(dir, 'config.toml'))).toBe(true);
  });

  it('returns true when content matches DEFAULT_CONFIG_FILE_TEXT exactly', async () => {
    const path = join(dir, 'config.toml');
    await ensureConfigFile(path);
    expect(await readFile(path, 'utf-8')).toBe(DEFAULT_CONFIG_FILE_TEXT);
    expect(await isConfigStubOrMissing(path)).toBe(true);
  });

  it('returns false when user added a single non-comment line', async () => {
    const modified =
      '# ~/.tea-code/config.toml\n' +
      '# Runtime settings for Kimi Code.\n' +
      '# This file starts empty so built-in defaults can apply.\n' +
      '# Login will populate managed Kimi provider and model entries.\n' +
      'default_thinking = true\n';
    await writeFile(join(dir, 'config.toml'), modified, 'utf-8');
    expect(await isConfigStubOrMissing(join(dir, 'config.toml'))).toBe(false);
  });

  it('returns false on any byte difference, even trailing whitespace', async () => {
    const stubPlusSpace =
      '# ~/.tea-code/config.toml\n' +
      '# Runtime settings for Kimi Code.\n' +
      '# This file starts empty so built-in defaults can apply.\n' +
      '# Login will populate managed Kimi provider and model entries.\n' +
      ' ';
    await writeFile(join(dir, 'config.toml'), stubPlusSpace, 'utf-8');
    expect(await isConfigStubOrMissing(join(dir, 'config.toml'))).toBe(false);
  });
});

describe('isTuiStubOrMissing', () => {
  it('returns true when tui.toml is missing', async () => {
    expect(await isTuiStubOrMissing(join(dir, 'tui.toml'))).toBe(true);
  });

  it('returns true for the current CLI default render', async () => {
    const defaultRender = renderTuiConfig(DEFAULT_TUI_CONFIG);
    await writeFile(join(dir, 'tui.toml'), defaultRender, 'utf-8');
    expect(await isTuiStubOrMissing(join(dir, 'tui.toml'))).toBe(true);
  });

  it('returns true when fields semantically equal default (even after parse round-trip)', async () => {
    // User loaded the file in an editor; their editor stripped trailing whitespace
    // or rewrote with different formatting but same fields.
    const reformatted =
      'theme = "auto"\n[editor]\ncommand = ""\n[notifications]\nenabled = true\nnotification_condition = "unfocused"\n';
    await writeFile(join(dir, 'tui.toml'), reformatted, 'utf-8');
    expect(await isTuiStubOrMissing(join(dir, 'tui.toml'))).toBe(true);
  });

  it('returns false when theme is changed', async () => {
    const modified =
      'theme = "dark"\n[editor]\ncommand = ""\n[notifications]\nenabled = true\nnotification_condition = "unfocused"\n';
    await writeFile(join(dir, 'tui.toml'), modified, 'utf-8');
    expect(await isTuiStubOrMissing(join(dir, 'tui.toml'))).toBe(false);
  });
});
