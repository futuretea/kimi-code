import { describe, expect, it } from 'vitest';

import {
  CUSTOM_THEME_SKILL,
  IMPORT_FROM_CC_CODEX_SKILL,
  MCP_CONFIG_SKILL,
  UPDATE_CONFIG_SKILL,
} from '#/app/skillCatalog/builtin/builtin';

const GLOBAL_HOME_SKILLS = [
  CUSTOM_THEME_SKILL,
  IMPORT_FROM_CC_CODEX_SKILL,
  MCP_CONFIG_SKILL,
  UPDATE_CONFIG_SKILL,
] as const;

describe('builtin global home guidance', () => {
  it('uses Tea global home and retains only explicit project-local .kimi-code paths', () => {
    for (const skill of GLOBAL_HOME_SKILLS) {
      expect(skill.content).toContain('TEA_CODE_HOME');
      expect(skill.content).toContain('~/.tea-code');
      expect(skill.content).not.toContain('KIMI_CODE_HOME');
    }
    expect(IMPORT_FROM_CC_CODEX_SKILL.content).toContain('<project root>/.kimi-code');
    expect(MCP_CONFIG_SKILL.content).toContain('<cwd>/.kimi-code/mcp.json');
  });
});
