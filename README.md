# Moved to @audio/plugin-wam

The WAM adapter now lives in [`@audio/plugin-wam`](https://github.com/audiojs/plugin/tree/main/packages/plugin-wam),
inside the [`@audio/plugin`](https://github.com/audiojs/plugin) umbrella. This checkout is retained
only for its Git history; it no longer defines an npm package.

Update imports from `@audio/wam` to `@audio/plugin-wam`, or import `toWam` from
`@audio/plugin`. There is no compatibility package. Both are on npm (they were
`@audio/compile-wam` and `@audio/compile` until 2026-11-23).
