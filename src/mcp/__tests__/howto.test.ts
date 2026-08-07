import { describe, it, expect } from 'vitest';
import { HOWTO_RESOURCE_URI, HOWTO_DIGEST_SUMMARY, readHowtoDoc } from '../howto.js';

describe('howto (issue #340)', () => {
  it('HOWTO_RESOURCE_URI は howto://agent-hub', () => {
    expect(HOWTO_RESOURCE_URI).toBe('howto://agent-hub');
  });

  it('readHowtoDoc は docs/peer-howto.md の内容を返す', () => {
    const content = readHowtoDoc();
    expect(content).toContain('caused_by');
    expect(content).toContain('scheduler');
  });

  it('HOWTO_DIGEST_SUMMARY は howto_uri を参照する', () => {
    expect(HOWTO_DIGEST_SUMMARY).toContain(HOWTO_RESOURCE_URI);
  });
});
