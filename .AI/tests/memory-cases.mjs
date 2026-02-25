import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_CASES_DIR = join(__dirname, '..', 'memory-test', 'cases');

/**
 * Loads test cases from .AI/memory-test/cases/.
 * Each subdirectory should contain: transcript, enhanced, and optionally notes.
 * These cases are specifically chosen to benefit from cross-meeting memory.
 */
export default function () {
  const cases = [];

  for (const dir of readdirSync(MEMORY_CASES_DIR)) {
    const caseDir = join(MEMORY_CASES_DIR, dir);
    let files;
    try {
      files = readdirSync(caseDir);
    } catch {
      continue;
    }

    const transcriptFile = files.find((f) => f.includes('transcript'));
    const enhancedFile = files.find((f) => f.includes('enhanced'));
    const notesFile = files.find((f) => f.includes('notes'));

    if (!transcriptFile || !enhancedFile) continue;

    const notes = notesFile
      ? readFileSync(join(caseDir, notesFile), 'utf-8')
      : '';

    cases.push({
      description: `memory:${dir}`,
      vars: {
        transcript: readFileSync(join(caseDir, transcriptFile), 'utf-8'),
        notes,
        golden: readFileSync(join(caseDir, enhancedFile), 'utf-8'),
      },
    });
  }

  return cases;
}
