# CHAOSVIZ

An entropy visualizer in a single `index.html` — no dependencies, works offline from `file://`.

The canvas starts black with **CHAOS** written in the center (thick ASCII art). Real-world entropy sources feed the visualization, and the colored squares/particles that arrive literally paint over and deteriorate the CHAOS lettering.

## Views

- **NOISE** (key `1`) — a field of colored squares (film-grain static). The static boils faster with more entropy; the CHAOS art is erased wherever new colored squares land.
- **PARTICLES** (key `2`) — a Brownian particle storm. CHAOS is formed by anchored white particles that dissolve into the storm as entropy flows.

## Entropy sources

All permission-free, each with a live toggle and bit-rate readout:

- **TIME** — high-resolution timer jitter
- **POINTER** — mouse/touch velocity and position; also paints directly on the canvas (brushes of colored squares in NOISE, particle sprays in PARTICLES)
- **KEYS** — inter-keystroke timing
- **CPU LOAD** — busy-loop probe
- **HW RNG** — `crypto.getRandomValues` throughput

The combined entropy rate drives the boil speed, hue rotation, and deterioration rate. Idle sources decay, so with everything still the view freezes.

## Controls

- `1`/`2` — switch views
- `p` — pause / resume
- `h` — hide the HUD
- Click source rows to toggle them
- Generation duration slider (2–60s) in the panel

## Development

- `index.html` — the entire app
- `smoke-test.js` — headless harness (runs the inline script in a VM with a DOM/canvas stub): `bun smoke-test.js`
