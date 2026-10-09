// PW-017 — edit_proposal v2 with the RFC-003 addition: a null outline revision is valid only for a
// conservative correction (grammar, concise) that says so in `intent`.
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import { validateEditProposal } from '../../../packages/contracts/src/index.ts';

const valid = JSON.parse(fs.readFileSync('examples/edit_proposal.valid.json', 'utf8'));

describe('edit_proposal v2 (RFC-003)', () => {
  test('existing valid proposals stay valid', () => {
    expect(validateEditProposal(valid).ok).toBe(true);
    expect(validateEditProposal({ ...valid, intent: 'rewrite' }).ok).toBe(true);
  });
  test('a pre-approval proposal needs a conservative intent', () => {
    expect(validateEditProposal({ ...valid, outline_revision_id: null, intent: 'grammar' }).ok).toBe(true);
    expect(validateEditProposal({ ...valid, outline_revision_id: null, intent: 'concise' }).ok).toBe(true);
    expect(validateEditProposal({ ...valid, outline_revision_id: null, intent: 'rewrite' }).ok).toBe(false);
    expect(validateEditProposal({ ...valid, outline_revision_id: null }).ok).toBe(false);
    expect(validateEditProposal({ ...valid, intent: 'delete' }).ok).toBe(false);
    const { outline_revision_id: _o, ...missing } = valid;
    void _o;
    expect(validateEditProposal(missing).ok).toBe(false);
  });
});
