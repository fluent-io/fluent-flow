# Contributing to Fluent Flow

## Getting Started

```bash
git clone https://github.com/fluent-io/fluent-flow.git
cd fluent-flow
npm install
cp .env.example .env
```

## Development

```bash
npm run dev      # start with hot reload
npm test         # run tests once
npm run test:watch  # run tests in watch mode
```

## Tests

All code changes must include tests. We use [Vitest](https://vitest.dev/).

```bash
tests/
└── unit/        # pure function + mocked unit tests
```

Run tests before submitting a PR:

```bash
npm test
```

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Write tests for any new functionality
3. Ensure `npm test` passes
4. Open a PR with a clear description of the change

## Code Style

- ESM imports (`import`/`export`), not CommonJS
- Structured logging with JSON objects (`console.log({ msg: '...' })`)
- Zod for validation
- No ORMs — raw `pg` queries

## Reporting Issues

Open an issue at [github.com/fluent-io/fluent-flow/issues](https://github.com/fluent-io/fluent-flow/issues).
