# Moved to @audio/compile-wam

The WAM adapter now lives in [`@audio/compile-wam`](https://github.com/audiojs/compile/tree/main/packages/compile-wam),
inside the [`@audio/compile`](https://github.com/audiojs/compile) umbrella. This checkout is retained
only for its Git history; it no longer defines an npm package.

Update imports from `@audio/wam` to `@audio/compile-wam`, or import `toWam` from
`@audio/compile`. There is no compatibility package. The new package name has
not been published by this migration.
