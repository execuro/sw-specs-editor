# Third-party notices

`@execuro-sw-ecosystem/sw-specs-editor` has **zero runtime dependencies**. One
third-party file is vendored into the published package, and one library is
fetched by the browser at page load.

## Vendored

### marked

`page/vendor/marked.min.js` — marked v15.0.12, MIT License,
Copyright (c) 2011-2025 Christopher Jeffrey.
<https://github.com/markedjs/marked>

Vendored unchanged from
`https://cdnjs.cloudflare.com/ajax/libs/marked/15.0.12/marked.min.js`.
The full licence text is in `page/vendor/LICENSE-marked.txt`.

## Fetched by the browser, not bundled

### Excalidraw

The diagram editor loads `@excalidraw/excalidraw` from a pinned esm.sh URL when
the user opens a diagram. It is **not** part of this package and is never
fetched by the CLI or the server. Offline, the page renders the diagram's
stored SVG instead. Excalidraw is MIT licensed,
Copyright (c) 2020 Excalidraw. <https://github.com/excalidraw/excalidraw>
