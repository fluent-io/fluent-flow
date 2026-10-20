/**
 * Identity slice of the collaboration layer (principals, passwords,
 * invitations, workspace bootstrap). Facade over the collaboration modules;
 * see ./index.ts for the full export surface and the package README.
 *
 * OWNERSHIP: A (persistence/API coder) owns every file in
 * packages/db/src/collaboration/. Other owners consume these exports through
 * `@fluent-flow/db` — do not add parallel implementations here.
 */
export * from './index.js';
