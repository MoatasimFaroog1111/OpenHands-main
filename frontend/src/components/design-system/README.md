# Frontend Design-System Boundary

The application frontend and the published `@openhands/ui` package have different
release/build lifecycles today. Feature code must not couple itself to either
implementation while those lifecycles converge.

## Ownership

- `openhands-ui/` owns reusable OpenHands design-system primitives and their
  public package API.
- `frontend/src/components/design-system/` owns the application-facing adapter
  contracts for primitives that are being migrated.
- `frontend/src/components/features/`, `shared/`, and `v1/` own application
  behavior and should consume migrated primitives through the adapter boundary.

## Migration rule

For each primitive:

1. Define the smallest app-facing contract in this directory.
2. Keep the current implementation behind the adapter (HeroUI 2.x today).
3. Migrate a small set of consumers without changing behavior.
4. Protect those consumers with the boundary check.
5. When `@openhands/ui` is ready for the main frontend toolchain, replace the
   adapter implementation rather than rewriting feature code.
6. Remove the old dependency only after all consumers are migrated and tests,
   typecheck, lint, and build prove it unused.

Do not perform a HeroUI 3 rewrite as part of this migration. Do not import
`@openhands/ui` source files by relative filesystem paths; the public package
boundary must remain the future integration point.

## Current migrated primitives

- Button adapter: used by `shared/buttons/icon-button.tsx`.
- Tooltip adapter: used by `shared/buttons/trajectory-action-button.tsx`.

The remaining direct HeroUI imports are intentional legacy consumers and should
be migrated incrementally in later changes.
