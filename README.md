# @printhive/bambu

A type-first Bambu Lab printer client for [Effect](https://effect.website), with a built-in emulator, on Bun and Node.js.

It is in early development, and nothing is published yet. The design lives in PrintHive/hive under `docs/design/printhive-bambu`.

It builds on [@printhive/mqtt](https://github.com/PrintHive/mqtt), [@printhive/lanscout](https://github.com/PrintHive/lanscout), and [@printhive/bambu-models](https://github.com/PrintHive/bambu-models).

## Clean room

Everything here comes from PrintHive's own scrubbed captures and from permissively licensed or factual sources, such as pybambu (MIT) and OpenBambuAPI. Never copy from or derive from AGPL or GPL projects, such as BambuStudio or OrcaSlicer. Those may be used only to cross-check.

## Develop

```sh
bun install
bun run check
bun run build
```

## License

MIT
