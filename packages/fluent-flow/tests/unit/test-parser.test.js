import { describe, it, expect } from 'vitest';
import { parseCheckAnnotations } from '../../src/github/test-parser.js';

describe('parseCheckAnnotations', () => {
  it('extracts test failures from GitHub check annotations', () => {
    const annotations = [
      {
        path: 'src/foo.test.js',
        start_line: 42,
        title: 'should validate input',
        message: 'Expected true but got false',
        annotation_level: 'failure'
      },
      {
        path: 'src/bar.test.js',
        start_line: 105,
        title: 'should render button',
        message: 'Timeout waiting for element',
        annotation_level: 'failure'
      }
    ];

    const result = parseCheckAnnotations(annotations);

    expect(result.failed).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toEqual({
      file: 'src/foo.test.js',
      line: 42,
      title: 'should validate input',
      message: 'Expected true but got false'
    });
    expect(result.failures[1]).toEqual({
      file: 'src/bar.test.js',
      line: 105,
      title: 'should render button',
      message: 'Timeout waiting for element'
    });
  });

  it('ignores non-failure annotations', () => {
    const annotations = [
      { annotation_level: 'notice', message: 'Info' },
      { annotation_level: 'warning', message: 'Warning' },
      { annotation_level: 'failure', message: 'Real failure', path: 'test.js', title: 'fail' }
    ];

    const result = parseCheckAnnotations(annotations);
    expect(result.failures).toHaveLength(1);
    expect(result.failed).toBe(1);
  });

  it('handles empty annotations array', () => {
    const result = parseCheckAnnotations([]);

    expect(result.failed).toBe(0);
    expect(result.failures).toHaveLength(0);
    expect(result.passed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('handles missing optional fields', () => {
    const annotations = [
      {
        annotation_level: 'failure'
        // path, start_line, title, message all missing
      }
    ];

    const result = parseCheckAnnotations(annotations);

    expect(result.failed).toBe(1);
    expect(result.failures[0]).toEqual({
      file: 'unknown',
      line: null,
      title: 'Test failed',
      message: ''
    });
  });

  it('handles null annotations', () => {
    const result = parseCheckAnnotations(null);

    expect(result.failed).toBe(0);
    expect(result.failures).toHaveLength(0);
  });
});
