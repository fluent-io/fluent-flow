// Remove comments added by the current branch (relative to origin/main) from
// code and test files. Only touches lines that are NEW relative to origin/main.
//
// Strategy:
//   1. Parse `git diff origin/main -- <file>` to get the set of line numbers in
//      the NEW file that are additions ('+' lines).
//   2. Read the current file, scan for comment spans (// line comments, /* */
//      and /** */ block comments) with a proper string/template-aware scanner.
//   3. For each comment span whose every line is an added line:
//        - line comment: keep the code before the comment (if any), drop the
//          comment; delete the line if it becomes empty
//        - block comment: keep code before the start (if any) and code after
//          the end (if any) on the boundary lines; drop the middle lines;
//          collapse the result, deleting the line if nothing remains
//   4. Write the result back. Files with no removable comments are untouched.
//
// Safety: if a comment span is only partially added (some lines pre-existing
// in origin/main), it is left alone and reported.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

function parseAddedLines(file) {
  // Returns a Set of 1-based line numbers in the NEW version of the file
  // that were added by the branch.
  let out;
  try {
    out = execSync(`git diff origin/main --unified=999999 -- ${JSON.stringify(file)}`, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    if (e.status === 0) out = '';
    else throw new Error(`git diff failed for ${file}: ${e.message}`);
  }
  const added = new Set();
  if (!out) return added;
  const lines = out.split('\n');
  let newLine = 0; // 1-based counter for the new file
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        newLine = parseInt(m[1], 10);
        inHunk = true;
      }
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ||
        line.startsWith('index ') || line.startsWith('old mode') || line.startsWith('new file')) {
      inHunk = false;
      continue;
    }
    if (line.startsWith('+')) {
      added.add(newLine);
      newLine++;
    } else if (line.startsWith('-')) {
      // removed line: newLine unchanged
    } else if (line.startsWith(' ')) {
      newLine++;
    }
    // blank lines in diff output between hunks: ignore
  }
  return added;
}

// Scan one line for the start of a comment, skipping string literals.
// Returns { index, type: 'line' | 'block' } or null.
function findCommentStart(line) {
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && i + 1 < n) {
      if (line[i + 1] === '/') return { index: i, type: 'line' };
      if (line[i + 1] === '*') return { index: i, type: 'block' };
    }
    i++;
  }
  return null;
}

// Find where a /* ... */ block comment ends, starting from line `startLine`
// at column `startCol`. Returns { endLine, endCol } (endCol = position after
// the closing */), or null if unterminated.
function findBlockEnd(fileLines, startLine, startCol) {
  for (let j = startLine; j < fileLines.length; j++) {
    const line = fileLines[j];
    const idx = line.indexOf('*/', startCol);
    if (idx !== -1) return { endLine: j, endCol: idx + 2 };
    startCol = 0;
  }
  return null;
}

// Collect all comment spans in the file. Each span:
//   { type: 'line', start: lineIdx, end: lineIdx, startCol }
//   { type: 'block', start: lineIdx, end: lineIdx, startCol, endCol }
function collectCommentSpans(lines) {
  const spans = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const found = findCommentStart(lines[i]);
    if (!found) { i++; continue; }
    if (found.type === 'line') {
      spans.push({ type: 'line', start: i, end: i, startCol: found.index });
      i++;
    } else {
      const end = findBlockEnd(lines, i, found.index + 2);
      if (!end) { i++; continue; } // unterminated: skip
      spans.push({ type: 'block', start: i, end: end.endLine, startCol: found.index, endCol: end.endCol });
      i = end.endLine + 1;
    }
  }
  return spans;
}

function processFile(file, verbose = true) {
  let added;
  try {
    added = parseAddedLines(file);
  } catch (e) {
    console.log(`SKIP ${file}: ${e.message}`);
    return { status: 'error', file, errors: [e.message] };
  }

  const original = readFileSync(file, 'utf8');
  const lines = original.split('\n');
  const spans = collectCommentSpans(lines);

  const linesToDelete = new Set();
  const edits = new Map(); // lineIdx -> replacement text
  const unremovable = []; // spans we could not safely remove

  for (const span of spans) {
    // Check every line of the span: all must be added lines.
    // (For 1-based: line index j => line number j+1)
    const allAdded = [];
    let every = true;
    for (let j = span.start; j <= span.end; j++) {
      const isAdded = added.has(j + 1);
      allAdded.push(isAdded);
      if (!isAdded) every = false;
    }
    if (!every) {
      // Partially pre-existing span: leave it alone.
      unremovable.push({ file, span, reason: 'partially pre-existing' });
      continue;
    }

    if (span.type === 'line') {
      const line = lines[span.start];
      const codeBefore = line.slice(0, span.startCol);
      if (codeBefore.trim() === '') {
        linesToDelete.add(span.start);
      } else {
        const trimmed = codeBefore.replace(/\s+$/, '');
        edits.set(span.start, trimmed);
      }
    } else {
      // block comment
      const firstLine = lines[span.start];
      const lastLine = lines[span.end];
      const before = firstLine.slice(0, span.startCol);
      const after = lastLine.slice(span.endCol);
      if (span.start === span.end) {
        const combined = before + after;
        if (combined.trim() === '') {
          linesToDelete.add(span.start);
        } else {
          edits.set(span.start, combined.replace(/^\s+/, '').replace(/\s+$/, ''));
        }
      } else {
        // multi-line: first and last lines may carry code; middle lines are
        // pure comment (part of the span) and get deleted.
        const first = before.replace(/\s+$/, '');
        const last = after.replace(/^\s+/, '');
        if (first.trim() === '') linesToDelete.add(span.start);
        else edits.set(span.start, first);
        if (last.trim() === '') linesToDelete.add(span.end);
        else edits.set(span.end, last);
        for (let j = span.start + 1; j < span.end; j++) linesToDelete.add(j);
      }
    }
  }

  // Apply: build output, collapsing deleted lines. Also collapse any resulting
  // runs of blank lines that were created by deletions? No — only delete lines
  // that were entirely comment. We don't touch blank-line layout beyond that.
  //
  // Edge: if a line is deleted AND had a trailing comment removed leaving
  // empty, we may end up with a blank line. That's fine (keeps diff minimal).

  const output = [];
  for (let j = 0; j < lines.length; j++) {
    if (linesToDelete.has(j)) continue;
    output.push(edits.has(j) ? edits.get(j) : lines[j]);
  }

  const newContent = output.join('\n');
  if (newContent === original) {
    return { status: 'unchanged', file, unremovable };
  }
  writeFileSync(file, newContent);
  return { status: 'modified', file, unremovable, removedLines: linesToDelete.size, editedLines: edits.size };
}

const files = process.argv.slice(2);
const results = [];
for (const f of files) {
  results.push(processFile(f));
}
const changed = results.filter((r) => r.status === 'modified').map((r) => r.file);
const unchanged = results.filter((r) => r.status === 'unchanged').map((r) => r.file);
const errors = results.filter((r) => r.status === 'error');
console.log('---');
console.log(`modified: ${changed.length}`);
for (const f of changed) console.log(`  M ${f}`);
console.log(`unchanged: ${unchanged.length}`);
console.log(`errors: ${errors.length}`);
for (const r of errors) console.log(`  E ${r.file}: ${r.errors.join('; ')}`);
// report unremovable comments
const allUnremovable = results.flatMap((r) => (r.unremovable || []).map((u) => ({ file: r.file, ...u })));
if (allUnremovable.length) {
  console.log(`--- unremovable (partially pre-existing) comments: ${allUnremovable.length}`);
  for (const u of allUnremovable) {
    const snippet = u.span.type === 'block'
      ? u.span.start === u.span.end
        ? u.span.start // single line
        : `${u.span.start}-${u.span.end}`
      : u.span.start;
    console.log(`  ${u.file}:${snippet + 1} (line ${snippet + 1})`);
  }
}
