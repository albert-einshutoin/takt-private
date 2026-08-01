import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

const projectRoot = resolve(process.cwd());

const directoryCopies = [
  ['src/shared/prompts/en', 'dist/shared/prompts/en', '.md'],
  ['src/shared/prompts/ja', 'dist/shared/prompts/ja', '.md'],
  ['src/core/runtime/presets', 'dist/core/runtime/presets', '.sh'],
];

const fileCopies = [
  ['src/shared/i18n/labels_en.yaml', 'dist/shared/i18n/labels_en.yaml'],
  ['src/shared/i18n/labels_ja.yaml', 'dist/shared/i18n/labels_ja.yaml'],
];

for (const [sourceDirectory, destinationDirectory, extension] of directoryCopies) {
  const source = join(projectRoot, sourceDirectory);
  if (!statSync(source).isDirectory()) throw new Error(`required asset directory missing: ${sourceDirectory}`);
  const destination = join(projectRoot, destinationDirectory);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name) !== extension) continue;
    copyFileSync(join(source, entry.name), join(destination, entry.name));
  }
}

for (const [sourceFile, destinationFile] of fileCopies) {
  const source = join(projectRoot, sourceFile);
  if (!statSync(source).isFile()) throw new Error(`required asset file missing: ${sourceFile}`);
  const destination = join(projectRoot, destinationFile);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}
