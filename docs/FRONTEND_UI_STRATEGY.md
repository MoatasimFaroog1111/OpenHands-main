# Frontend UI convergence strategy

OpenHands currently has two distinct UI surfaces:

- `frontend/` — the production web application. It currently uses HeroUI and app-specific components.
- `openhands-ui/` — the separately published `@openhands/ui` component library with its own Storybook, styling, and release lifecycle.

They are intentionally **not** treated as interchangeable implementations today. Their component APIs, styling assumptions, toolchains, and dependency graphs differ.

## Dependency direction

Feature code in `frontend/src/components/features/` should depend on application-level UI contracts in `frontend/src/ui/` or existing shared app components, not directly on a third-party UI toolkit when a suitable app contract exists.

```text
feature component
    -> frontend/src/ui semantic contract
        -> current toolkit adapter (HeroUI today)
```

The concrete toolkit remains an outer implementation detail. This keeps future adoption of `@openhands/ui` local to adapters instead of requiring broad feature rewrites.

## Migration rules

1. Preserve existing visual and interaction behavior while introducing a semantic app contract.
2. Migrate one primitive and a small set of consumers at a time.
3. Add behavior tests at the contract boundary before expanding migration scope.
4. Do not bulk-replace HeroUI imports or remove `@openhands/ui` components.
5. Do not add `@openhands/ui` as a production dependency until the target component's API, styling, accessibility behavior, and bundle impact have been validated against the app contract.
6. Prefer semantic props such as `appearance="subtle"` over toolkit-specific tokens such as HeroUI's `variant="flat"` in feature-facing APIs.
7. Keep Storybook/public-library concerns inside `openhands-ui/`; keep application routing, data fetching, and feature state inside `frontend/`.

## First convergence slice: Button

`frontend/src/ui/button.tsx` defines the application Button contract and adapts it to HeroUI. `IconButton` is the first migrated consumer.

This establishes the intended seam without changing the public `@openhands/ui` package or forcing a cross-package dependency. A later slice may evaluate whether `@openhands/ui` can implement the same app contract behind this adapter.

## Exit criteria before replacing a toolkit implementation

For each primitive:

- consumer behavior tests pass;
- keyboard/accessibility behavior is equivalent or better;
- current visual states are preserved intentionally;
- no feature imports concrete toolkit APIs through the new contract;
- bundle/runtime impact is understood;
- frontend lint, typecheck, unit tests, and production build remain green.

This makes UI consolidation incremental and reversible rather than a large framework migration.
