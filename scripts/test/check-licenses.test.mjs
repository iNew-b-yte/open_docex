import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evalSpdx, findViolations, parseExceptions } from '../check-licenses.mjs';

describe('evalSpdx', () => {
  it.each(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0'])('allows %s', (id) => {
    expect(evalSpdx(id)).toBe(true);
  });

  it('matches identifiers case-insensitively', () => {
    expect(evalSpdx('mit')).toBe(true);
    expect(evalSpdx('apache-2.0')).toBe(true);
  });

  it('rejects licences outside the allowlist', () => {
    for (const id of ['MPL-2.0', 'GPL-3.0-only', 'AGPL-3.0-or-later', 'BlueOak-1.0.0', 'CC-BY-4.0']) {
      expect(evalSpdx(id)).toBe(false);
    }
  });

  it('rejects unknown identifiers, LicenseRef and the "+" suffix', () => {
    expect(evalSpdx('UNLICENSED')).toBe(false);
    expect(evalSpdx('SEE LICENSE IN LICENSE.txt')).toBe(false);
    expect(evalSpdx('LicenseRef-Proprietary')).toBe(false);
    expect(evalSpdx('Apache-2.0+')).toBe(false);
  });

  it('allows OR when any alternative is allowed', () => {
    expect(evalSpdx('MIT OR GPL-3.0-only')).toBe(true);
    expect(evalSpdx('GPL-3.0-only OR Apache-2.0')).toBe(true);
    expect(evalSpdx('GPL-2.0-only OR MPL-2.0')).toBe(false);
  });

  it('allows AND only when every part is allowed', () => {
    expect(evalSpdx('MIT AND ISC')).toBe(true);
    expect(evalSpdx('MIT AND BSD-3-Clause AND Apache-2.0')).toBe(true);
    expect(evalSpdx('MIT AND GPL-3.0-only')).toBe(false);
  });

  it('gives AND precedence over OR', () => {
    // GPL OR (MIT AND ISC)
    expect(evalSpdx('GPL-3.0-only OR MIT AND ISC')).toBe(true);
    // (MIT AND GPL) OR GPL
    expect(evalSpdx('MIT AND GPL-3.0-only OR GPL-2.0-only')).toBe(false);
  });

  it('honours parentheses', () => {
    expect(evalSpdx('(MIT OR GPL-3.0-only)')).toBe(true);
    expect(evalSpdx('(MIT OR GPL-3.0-only) AND ISC')).toBe(true);
    expect(evalSpdx('(MIT OR GPL-3.0-only) AND MPL-2.0')).toBe(false);
    expect(evalSpdx('MIT AND (GPL-3.0-only OR (BSD-2-Clause))')).toBe(true);
  });

  it('rejects WITH, even on an allowed licence', () => {
    expect(evalSpdx('Apache-2.0 WITH LLVM-exception')).toBe(false);
    expect(evalSpdx('GPL-2.0-only WITH Classpath-exception-2.0')).toBe(false);
    // The WITH term fails, but an allowed OR alternative still passes.
    expect(evalSpdx('Apache-2.0 WITH LLVM-exception OR MIT')).toBe(true);
    expect(evalSpdx('MIT AND Apache-2.0 WITH LLVM-exception')).toBe(false);
  });

  it('rejects malformed expressions', () => {
    for (const expression of [
      '',
      '   ',
      '(MIT',
      'MIT)',
      'MIT OR',
      'OR MIT',
      'MIT AND AND ISC',
      'MIT ISC',
      'MIT or ISC',
      'MIT WITH',
      '()',
      'MIT/ISC',
    ]) {
      expect(evalSpdx(expression), expression).toBe(false);
    }
  });

  it('rejects non-string input', () => {
    expect(evalSpdx(undefined)).toBe(false);
    expect(evalSpdx({ type: 'MIT' })).toBe(false);
  });
});

describe('parseExceptions', () => {
  const valid = {
    name: 'some-pkg',
    version: '1.2.3',
    licence: 'MPL-2.0',
    reason: 'Build tool only',
    approvedBy: 'project owner, 2026-11-22',
  };

  it('accepts an empty list and complete entries', () => {
    expect(parseExceptions([])).toEqual([]);
    expect(parseExceptions([valid])).toEqual([valid]);
  });

  it('rejects anything but an array of complete entries', () => {
    expect(() => parseExceptions({})).toThrow(TypeError);
    expect(() => parseExceptions([null])).toThrow(TypeError);
    expect(() => parseExceptions([[]])).toThrow(TypeError);
    for (const field of ['name', 'version', 'licence', 'reason', 'approvedBy']) {
      expect(() => parseExceptions([{ ...valid, [field]: undefined }]), field).toThrow(TypeError);
      expect(() => parseExceptions([{ ...valid, [field]: ' ' }]), field).toThrow(TypeError);
    }
  });

  it('accepts the committed licence-exceptions.json, which starts empty', () => {
    const file = new URL('../licence-exceptions.json', import.meta.url);
    expect(parseExceptions(JSON.parse(readFileSync(file, 'utf8')))).toEqual([]);
  });
});

describe('findViolations', () => {
  const nodes = [
    { name: 'ok', version: '1.0.0', license: 'MIT' },
    { name: 'bad', version: '2.0.0', license: 'GPL-3.0-only' },
    { name: 'legacy', version: '0.1.0', license: { type: 'MIT' } },
    { name: 'missing', version: '0.2.0' },
  ];

  it('reports disallowed, legacy-object and missing licences', () => {
    expect(findViolations(nodes, [])).toEqual([
      { name: 'bad', version: '2.0.0', license: 'GPL-3.0-only' },
      { name: 'legacy', version: '0.1.0', license: { type: 'MIT' } },
      { name: 'missing', version: '0.2.0', license: undefined },
    ]);
  });

  it('applies an exception to the exact name and version only', () => {
    const exceptions = [{ name: 'bad', version: '2.0.0' }, { name: 'legacy', version: '9.9.9' }];
    expect(findViolations(nodes, exceptions).map((v) => v.name)).toEqual(['legacy', 'missing']);
  });

  it('reports a package installed at several locations once', () => {
    const duplicate = { name: 'bad', version: '2.0.0', license: 'GPL-3.0-only' };
    expect(findViolations([duplicate, duplicate], [])).toHaveLength(1);
  });
});
