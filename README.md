# Sequence

**Permit requirement engine: topological review sequencing with jurisdiction rules as rows.**

Live: **https://sequence.levelbrook.com**

## What this is

A permit process is a set of requirements whose order is not fixed, where some reviews
cannot start until others finish, and where the rules differ per jurisdiction.

## Engineering notes

### Sequencing is computed, not hardcoded

Review order is a topological ordering over the
dependency graph rather than a fixed checklist, so adding a requirement does not mean rewriting the flow.

### Jurisdiction rules are table rows

Rules live in the database rather than as code branches.
The version that hardcodes them needs an engineer for every new jurisdiction.

### Blocked work explains itself

A requirement that cannot start reports which upstream review
it is waiting on, because "not ready" is not an actionable answer.

## Stack

Node.js, TypeScript, PostgreSQL, 15 tests

Tests: `npm test`

## Running it

```
npm install
npm test
npm start
```

## Honest scope

This is a focused engineering demo, not a production system. The data is synthetic and generated
locally so that the behaviour is reproducible. The reasoning, the arithmetic and the failure modes
are the point; the surface area is deliberately narrow.

## License

MIT
