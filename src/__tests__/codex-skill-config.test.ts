import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexSkillConfig } from '../infra/codex/skill-config.js';

const tempRoots = new Set<string>();

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-codex-skills-'));
  tempRoots.add(root);
  return root;
}

function createSkill(root: string, name: string): string {
  const skillDir = join(root, name);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, `# ${name}\n`, 'utf-8');
  return realpathSync(skillPath);
}

function disabledPaths(config: ReturnType<typeof buildCodexSkillConfig>): string[] {
  const skills = config?.skills as { config?: Array<{ path: string; enabled: boolean }> } | undefined;
  return skills?.config?.map((entry) => entry.path) ?? [];
}

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe('buildCodexSkillConfig', () => {
  it('returns no override when both scopes are inherited', () => {
    expect(buildCodexSkillConfig({
      cwd: '/path/that/does/not/exist',
      env: {},
      inheritance: { repo: true, user: true },
    })).toBeUndefined();
  });

  it('disables repository Skills from cwd through the repository root', () => {
    const root = createTempRoot();
    mkdirSync(join(root, '.git'));
    const rootSkill = createSkill(join(root, '.agents', 'skills'), 'root-skill');
    const cwd = join(root, 'packages', 'app');
    mkdirSync(cwd, { recursive: true });
    const nestedSkill = createSkill(join(cwd, '.agents', 'skills'), 'nested-skill');

    const config = buildCodexSkillConfig({
      cwd,
      env: { HOME: join(root, 'home') },
      inheritance: { repo: false, user: true },
    });

    expect(disabledPaths(config)).toEqual([nestedSkill, rootSkill].sort());
  });

  it('disables user Skills while excluding Codex system Skills', () => {
    const root = createTempRoot();
    const cwd = join(root, 'work');
    const home = join(root, 'home');
    const codexHome = join(root, 'codex-home');
    mkdirSync(cwd, { recursive: true });
    const agentsSkill = createSkill(join(home, '.agents', 'skills'), 'agents-user');
    const codexSkill = createSkill(join(codexHome, 'skills'), 'codex-user');
    createSkill(join(codexHome, 'skills', '.system'), 'system-skill');

    const config = buildCodexSkillConfig({
      cwd,
      env: { HOME: home, CODEX_HOME: codexHome },
      inheritance: { repo: true, user: false },
    });

    expect(disabledPaths(config)).toEqual([agentsSkill, codexSkill].sort());
  });

  it('treats a regular .agents file as a missing Skill root', () => {
    const root = createTempRoot();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.agents'), 'not a directory', 'utf-8');

    expect(buildCodexSkillConfig({
      cwd: root,
      env: { HOME: join(root, 'home') },
      inheritance: { repo: false, user: true },
    })).toBeUndefined();
  });

  it('does not scan deeper than the bounded Codex discovery depth', () => {
    const root = createTempRoot();
    mkdirSync(join(root, '.git'));
    const skillsRoot = join(root, '.agents', 'skills');
    const withinLimit = createSkill(
      join(skillsRoot, 'one', 'two', 'three', 'four', 'five'),
      'within-limit',
    );
    createSkill(
      join(skillsRoot, 'one', 'two', 'three', 'four', 'five', 'six'),
      'beyond-limit',
    );

    const config = buildCodexSkillConfig({
      cwd: root,
      env: { HOME: join(root, 'home') },
      inheritance: { repo: false, user: true },
    });

    expect(disabledPaths(config)).toEqual([withinLimit]);
  });

  it.skipIf(process.platform === 'win32')(
    'normalizes symlinks and removes duplicate directory cycles',
    () => {
      const root = createTempRoot();
      const cwd = join(root, 'work');
      mkdirSync(join(cwd, '.git'), { recursive: true });
      const skillsRoot = join(cwd, '.agents', 'skills');
      const skillPath = createSkill(skillsRoot, 'original');
      symlinkSync(join(skillsRoot, 'original'), join(skillsRoot, 'alias'));
      symlinkSync(skillsRoot, join(skillsRoot, 'cycle'));

      const config = buildCodexSkillConfig({
        cwd,
        env: { HOME: join(root, 'home') },
        inheritance: { repo: false, user: true },
      });

      expect(disabledPaths(config)).toEqual([skillPath]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'ignores unresolvable nested .git markers and uses the parent repository root',
    () => {
      const root = createTempRoot();
      mkdirSync(join(root, '.git'));
      const rootSkill = createSkill(join(root, '.agents', 'skills'), 'root-skill');
      const brokenRoot = join(root, 'broken');
      const cyclicRoot = join(root, 'cyclic');
      mkdirSync(join(brokenRoot, 'deep'), { recursive: true });
      mkdirSync(join(cyclicRoot, 'deep'), { recursive: true });
      symlinkSync('missing-target', join(brokenRoot, '.git'));
      symlinkSync('.git', join(cyclicRoot, '.git'));

      for (const cwd of [join(brokenRoot, 'deep'), join(cyclicRoot, 'deep')]) {
        const config = buildCodexSkillConfig({
          cwd,
          env: { HOME: join(root, 'home') },
          inheritance: { repo: false, user: true },
        });
        expect(disabledPaths(config)).toEqual([rootSkill]);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'skips hidden directories but follows a visible symlink to a hidden target',
    () => {
      const root = createTempRoot();
      mkdirSync(join(root, '.git'));
      const skillsRoot = join(root, '.agents', 'skills');
      const hiddenSkill = createSkill(join(skillsRoot, '.hidden'), 'linked-skill');
      symlinkSync(join(skillsRoot, '.hidden'), join(skillsRoot, 'visible-link'));
      createSkill(join(skillsRoot, '.ignored'), 'ignored-skill');

      const config = buildCodexSkillConfig({
        cwd: root,
        env: { HOME: join(root, 'home') },
        inheritance: { repo: false, user: true },
      });

      expect(disabledPaths(config)).toEqual([hiddenSkill]);
    },
  );
});
