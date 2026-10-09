// PW-041 — what counts as a section that was read, and what counts as copied wording.
import { describe, expect, test } from 'vitest';
import { COPY_RUN, copies, copyIndex, sectionServes, sectionsOf } from '../../../packages/domain/src/writing-profile/index.ts';

describe('sectionsOf: headings on a line of their own', () => {
  test('numbered, upper-case, with a colon, and the usual synonyms', () => {
    const t = 'Title of the paper\nABSTRACT\nWe show x.\n1. Introduction\nBackground text.\n2 Materials and Methods\nWe grew plants.\nII. RESULTS AND DISCUSSION:\nRoots respond.\n3.1 Conclusions\nDone.';
    expect(sectionsOf(t).map((s) => [s.section, s.text])).toEqual([
      ['Abstract', 'We show x.'], ['Introduction', 'Background text.'], ['Methods', 'We grew plants.'], ['Results and Discussion', 'Roots respond.'], ['Conclusion', 'Done.'],
    ]);
  });
  test('a heading word inside a sentence, an empty section, or text before any heading is not a section read', () => {
    expect(sectionsOf('The discussion of results follows.\nResults are shown below.')).toEqual([]);
    expect(sectionsOf('Discussion\n\nResults\nRoots respond.').map((s) => s.section)).toEqual(['Results']);
    expect(sectionsOf('Preface text only.')).toEqual([]);
  });
  test('a section split across pages is one section', () => {
    expect(sectionsOf('Discussion\nPart one.\nDiscussion\nPart two.')).toEqual([{ section: 'Discussion', text: 'Part one.\nPart two.' }]);
  });
  test('a combined Results and Discussion serves both roles; nothing else serves another', () => {
    expect(sectionServes('Results and Discussion', 'Discussion')).toBe(true);
    expect(sectionServes('Results and Discussion', 'Results')).toBe(true);
    expect(sectionServes('Abstract', 'Discussion')).toBe(false);
    expect(sectionServes('Results', 'Discussion')).toBe(false);
  });
});

describe('copies: a run of words from a source', () => {
  const index = copyIndex(['Our results extend earlier reports by showing that the response is confined to roots.']);
  test(`${COPY_RUN} words in a row, ignoring case and punctuation, is a copy`, () => {
    expect(copies('as they say, OUR RESULTS extend earlier reports by showing that', index)).toBe(true);
    expect(copies('Our results — extend, earlier: reports by showing that', index)).toBe(true);
  });
  test(`${COPY_RUN - 1} words, or the same words reordered, is not`, () => {
    expect(copies('Our results extend earlier reports by showing', index)).toBe(false);
    expect(copies('showing that our results extend earlier reports by', index)).toBe(false);
  });
});
