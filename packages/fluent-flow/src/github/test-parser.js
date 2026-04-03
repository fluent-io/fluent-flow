/**
 * Parse GitHub check run annotations into structured test failures.
 * @param {Array} annotations - GitHub check annotations
 * @returns {object} { passed, failed, skipped, failures }
 */
export function parseCheckAnnotations(annotations = []) {
  const annotationsList = annotations || [];
  const failures = annotationsList
    .filter((a) => a.annotation_level === 'failure')
    .map((a) => ({
      file: a.path || 'unknown',
      line: a.start_line || null,
      title: a.title || 'Test failed',
      message: a.message || ''
    }));

  return {
    passed: 0,  // We don't get this from annotations, computed later
    failed: failures.length,
    skipped: 0,
    failures
  };
}
