import loadStandardCases from './cases.mjs';
import loadMemoryCases from './memory-cases.mjs';

/**
 * Combines standard eval cases with memory-specific test cases.
 */
export default function () {
  return [...loadStandardCases(), ...loadMemoryCases()];
}
