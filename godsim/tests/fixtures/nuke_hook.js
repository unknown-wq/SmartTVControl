// Test-only hook (appended to the build with --extra): exposes the nuke graphics plugin and the plugin registry to the page for sprite review,
// bake counters and per-effect draw timing. Not part of the game build.
if (typeof window !== 'undefined') { window.__gfxNuke = GfxNuke; window.__gfxPlugins = GfxPlugins; }
