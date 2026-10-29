import { Emitter, type Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';

import { visibleBuiltinSkills } from './builtin/builtin';
import {
  BUILTIN_PRODUCT_SKILLS_SECTION,
  builtinProductSkillsEnabled,
} from './configSection';
import {
  BUILTIN_SKILL_SOURCE_ID,
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from './skillSource';

export interface IBuiltinSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IBuiltinSkillSource: ServiceIdentifier<IBuiltinSkillSource> =
  createDecorator<IBuiltinSkillSource>('builtinSkillSource');

export class BuiltinSkillSource extends Disposable implements IBuiltinSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = BUILTIN_SKILL_SOURCE_ID;
  readonly priority = SKILL_SOURCE_PRIORITY.builtin;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {
    super();
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === BUILTIN_PRODUCT_SKILLS_SECTION) this.onDidChangeEmitter.fire();
      }),
    );
  }

  async load(): Promise<SkillContribution> {
    await this.config.ready;
    const skills = visibleBuiltinSkills(builtinProductSkillsEnabled(this.config), this.flags);
    if (!this.bootstrap.args.forwardTeaCodeHome) return { skills };
    const useTeaHome = (text: string): string => text
      .replaceAll('KIMI_CODE_HOME', 'TEA_CODE_HOME')
      .replaceAll('~/.kimi-code', '~/.tea-code')
      .replaceAll('$HOME/.kimi-code', '$HOME/.tea-code');
    return {
      skills: skills.map((skill) => ({
        ...skill,
        content: useTeaHome(skill.content),
        description: useTeaHome(skill.description),
      })),
    };
  }
}

registerScopedService(
  LifecycleScope.App,
  IBuiltinSkillSource,
  BuiltinSkillSource,
  ScopeActivation.OnScopeCreated,
  'skillCatalog',
);
