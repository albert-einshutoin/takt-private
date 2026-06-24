#!/usr/bin/env node

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { formatDevloopDoctorReport, runDevloopDoctor } from '../../devloopd/doctor.js';
import { getErrorMessage } from '../../shared/utils/error.js';

const require = createRequire(import.meta.url);
const { version: cliVersion } = require('../../../package.json') as { version: string };

const program = new Command();

program
  .name('devloopd')
  .description('devloopd sidecar utilities for TAKT subscription-only development loops')
  .version(cliVersion);

program
  .command('doctor')
  .description('Check local subscription-only provider readiness')
  .option('--subscription-only', 'Require TAKT subscription-only policy checks')
  .option('--repo <path>', 'Repository path to inspect', process.cwd())
  .option('--policy <path>', 'devloopd policy YAML path')
  .option('--verbose', 'Show passing checks')
  .option('--skip-auth', 'Skip GitHub CLI auth status check')
  .action(async (options: {
    subscriptionOnly?: boolean;
    repo: string;
    policy?: string;
    verbose?: boolean;
    skipAuth?: boolean;
  }) => {
    const report = await runDevloopDoctor({
      repoPath: resolve(options.repo),
      policyPath: options.policy ? resolve(options.policy) : undefined,
      subscriptionOnly: options.subscriptionOnly === true,
      verbose: options.verbose === true,
      skipAuth: options.skipAuth === true,
    });

    console.log(formatDevloopDoctorReport(report, { verbose: options.verbose === true }));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((error: unknown) => {
  console.error(getErrorMessage(error));
  process.exit(1);
});
