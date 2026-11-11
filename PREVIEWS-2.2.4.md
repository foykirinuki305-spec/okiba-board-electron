# 2.2.4 — recognizable material previews

This update changes board artwork only. Cell dimensions, saved coordinates,
material locations, link attributes, notes, and board data schema are unchanged.

- Images and videos use Windows-generated thumbnails when available.
- Other files, and media without an available thumbnail, use Windows file icons.
- Folders retain their recognizable dedicated yellow folder symbol (Electron on
  Windows can incorrectly return a drive icon for a directory).
- Preview images fit inside their existing slot without cropping their edges.
- Thumbnail requests are asynchronous, deduplicated and concurrency-limited.

This is not a promise that every codec produces a video thumbnail: thumbnail
support follows the installed Windows thumbnail providers. A native file icon
remains the fallback when a provider cannot decode a file.

## Verification

Tests use isolated synthetic boards and redirected Desktop/Downloads locations.
Never run the Explorer desktop positioning tests on the user's actual desktop.
Their full coverage runs on a disposable Windows CI runner instead.

The existing v2.2.3 installation is not modified by development or testing.
Final CI run, artifact hashes and installation status are reported separately.
