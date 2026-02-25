import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VARIANT_DIR = join(__dirname, '..', 'prompt-variants', 'memory');
const MEMORY_FILE = join(__dirname, '..', 'memory-test', 'memory.txt');

export default async function ({ vars }) {
  const systemPrompt = readFileSync(join(VARIANT_DIR, 'system.txt'), 'utf-8');
  const userTemplate = readFileSync(join(VARIANT_DIR, 'user.txt'), 'utf-8');
  const memoryContent = readFileSync(MEMORY_FILE, 'utf-8');

  const hasNotes = !!vars.notes?.trim();

  // Match production injections from session.rs
  let systemMessage =
    systemPrompt +
    '\n\nUSER IDENTITY: You are Khalil. ' +
    'Your microphone audio is labeled [Mic] in the transcript.' +
    '\n\nSPEAKER CONTEXT: Transcript labels indicate audio sources, not individual speakers.' +
    '\n- [Mic] = your microphone. In in-person or hybrid meetings, this captures everyone in the room.' +
    '\n- [Other] = system audio from remote participants (e.g. a video call).' +
    '\nIf only [Mic] segments appear, multiple speakers are likely mixed together. ' +
    'Do not assume one person said everything.';

  // Memory injection — mirrors planned production injection in session.rs
  if (memoryContent.trim()) {
    systemMessage +=
      '\n\n<memory>\n' +
      memoryContent.trim() +
      '\n</memory>\n\n' +
      'MEMORY USAGE: The above is context from your recent meetings. ' +
      'Use it to recognize ongoing threads, avoid restating known context, ' +
      'and connect new information to existing patterns. ' +
      'Do NOT force references — only use when it genuinely improves the notes.';
  }

  const notesSection = hasNotes ? vars.notes : 'No notes were taken.';
  const userMessage = `<user_notes>\n${notesSection}\n</user_notes>\n\n<transcript>\n${vars.transcript}\n</transcript>\n\n${userTemplate}`;

  return [
    { role: 'system', content: systemMessage },
    { role: 'user', content: userMessage },
  ];
}
