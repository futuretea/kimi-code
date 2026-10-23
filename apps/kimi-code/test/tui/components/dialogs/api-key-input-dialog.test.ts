import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { promptApiKey } from '#/tui/commands/prompts';
import { ApiKeyInputDialogComponent } from '#/tui/components/dialogs/api-key-input-dialog';

describe('ApiKeyInputDialogComponent', () => {
  it('shows the current harness configuration path in the API key prompt', async () => {
    let dialog: ApiKeyInputDialogComponent | undefined;
    const host = {
      harness: { configPath: '/tmp/tea-home/config.toml' },
      mountEditorReplacement: (component: ApiKeyInputDialogComponent) => {
        dialog = component;
      },
      restoreEditor: vi.fn(),
    } as unknown as SlashCommandHost;
    const result = promptApiKey(host, 'Kimi Platform');

    const output = dialog!.render(100).join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');
    expect(output).toContain('Your key will be saved to /tmp/tea-home/config.toml');
    expect(output).not.toContain('.kimi-code');
    dialog!.handleInput('\u001B');
    await expect(result).resolves.toBeUndefined();
    expect(host.restoreEditor).toHaveBeenCalledOnce();
  });

  it('keeps every line within narrow widths', () => {
    const dialog = new ApiKeyInputDialogComponent(
      'Kimi Code',
      ['Paste your API key below.', 'It will be stored locally.'],
      () => {},
    );
    dialog.focused = true;

    for (const width of [39, 20, 10]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
