import { normalizeRecordName } from '../scripts/preflight-check';

describe('preflight normalizeRecordName', () => {
  it('converts the Route 53 wildcard escape back to *', () => {
    expect(normalizeRecordName('\\052.example.com.')).toBe('*.example.com.');
  });

  it('lowercases and leaves ordinary names alone', () => {
    expect(normalizeRecordName('WWW.Example.com.')).toBe('www.example.com.');
  });
});
