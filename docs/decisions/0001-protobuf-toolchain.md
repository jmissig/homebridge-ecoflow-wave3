# Decision 0001: Protobuf and test toolchain

- Date: 2026-07-28
- Status: accepted for the first protocol slice

## Context

The plugin needs strict TypeScript types, proto3 optional-field presence,
binary encode/decode support, ESM/NodeNext compatibility, and deterministic
tests. The checked-in schema will be a small reviewed WAVE-3-only subset.

Package versions were checked from npm on 2026-07-28.

## Options considered

### Buf Protobuf-ES

- `@bufbuild/protobuf` 2.13.0
- `@bufbuild/protoc-gen-es` 2.13.0
- `@bufbuild/buf` 1.72.0
- Generates modern TypeScript/ESM schema code.
- Preserves protobuf field presence and unknown fields through the generated
  runtime.
- Makes the schema-to-code step explicit and reviewable.
- Adds a code-generation step and generated source.

### protobuf.js

- `protobufjs` 8.7.1
- Can load a `.proto` dynamically with little setup.
- Would require manual domain typing or additional static-generation tooling.
- Runtime schema loading adds package-path and startup concerns that are not
  useful for this small fixed protocol.

### protobuf-ts

- `@protobuf-ts/runtime` and `@protobuf-ts/plugin` 2.11.1
- Provides generated TypeScript and presence-aware messages.
- Is capable, but offers no project-specific advantage over the more current
  Buf toolchain for this slice.

## Decision

Use Buf Protobuf-ES:

- `@bufbuild/protobuf` as a runtime dependency
- `@bufbuild/buf` and `@bufbuild/protoc-gen-es` as development dependencies
- check in the reviewed `.proto` and generated TypeScript
- expose `npm run proto:generate`
- verify generated output is current in CI

Use Node's built-in test runner through `tsx` rather than introducing a larger
test framework. This keeps TypeScript tests ESM-native and the test surface
small.

## Consequences

- Protocol messages are generated and type-safe.
- The generated file is derived Apache-2.0 material and must retain a
  provenance notice.
- Schema changes require regeneration and review.
- Routine runtime does not parse or locate a `.proto` file.
- Tests run with `tsx --test` and require no live Homebridge, EcoFlow account,
  MQTT broker, or device.
