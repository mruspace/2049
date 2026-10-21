<p align="center">
  <a href="https://mru.space">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://mru.space/assets/readme/mru-github-dark.gif">
      <img src="https://mru.space/assets/readme/mru-github-light.gif" alt="Mru" width="120" height="120">
    </picture>
  </a>
</p>

# Mru 2049

Lab project. Not part of Mru Flight or Mru Field.

A browser flight simulator. You sit in a rocket cockpit and fly anywhere in the
solar system and out into the nearby galaxy, on real astronomical data.

Planet positions come from VSOP87 and are correct for whatever date you set.
Stars come from the HYG catalogue: 109,389 real stars at their real distances,
magnitudes and colours. There is no combat, no economy and no mission
structure.

The product sells one thing: **the sense of scale**. Fly to Mars and the Sun
shrinks while Earth falls away to a point. Fly to Sirius and the whole solar
system collapses into a single star while the constellations come apart behind
you. That last effect is the most memorable thing here, and it is free once the
data is real.

Sessions are five to fifteen minutes. There is no progression and no reason to
come back except to look at something else. That is fine.

## Running it

```bash
npm install
npm run dev
```

The data files in `public/` are committed, so a fresh clone flies without
building any assets. `npm run check` runs the type checker, the tests and the
linter.

### Controls

| Input | Effect |
|---|---|
| Mouse | Pitch and yaw. **Rate based**: hold the pointer off centre and the ship keeps turning |
| `Space` | Full throttle. The ship handles the arrival, so this is the normal way to go somewhere |
| `W` / `S` | Throttle, logarithmic, 1 m/s to 1000 light years per second |
| `Shift` | Hold for ten times the throttle rate |
| `A` / `D` | Roll |
| `X` | Full stop |
| `O` | Match orbit with the nearest body |
| `F` | Find an object by name |
| Right-drag | Free look, without steering |
| Click | Target whatever is under the pointer |

On a touch screen: drag the left side to steer, drag the right edge strip for
the throttle, and use the on-screen buttons for roll and full stop.

### URL switches

| Switch | Effect |
|---|---|
| `?webgl` | Force the WebGL2 backend, to test the fallback path |
| `?debug=sky` | Show the star pass alone, amplified 400x |
| `?debug=scene` | Show the scene pass alone, with no sky |
| `?debug=depth` | Show linear depth, which is what composites the sky |
| `?debug=alpha` | Show the scene pass's alpha channel |

## How it is put together

Everything runs in the browser. No server, no API, no database.

```
sim     Ship state, date, flight. All Float64. Never imports three.js
ephem   Body positions and orientations from astronomy-engine
scene   Meshes, materials, and the per-frame rebase
render  Renderer, post chain, auto-exposure, textures
input   Keyboard, pointer and touch, into one control struct
ui      HUD and panels. Never renders inside the frame loop
tools   Build-time scripts. Their output is committed
```

### The coordinate system

This is the load-bearing part. A Float32 holds about seven significant digits,
the cockpit is measured in metres, and Neptune is 4.5e12 m away. There is no
single Float32 space that holds both.

1. **Float64 on the CPU.** All simulation state is metres in the J2000 mean
   equatorial frame, heliocentric. It never enters a shader.
2. **Floating origin.** Every frame, the ship position is subtracted from
   everything in Float64 and only the remainder is uploaded. The camera sits at
   exactly (0,0,0) and never moves.
3. **Reverse-Z depth**, near 0.1 m and far 1e9 m. It is behind a runtime toggle,
   because it is young upstream and because WebGL2 needs an extension Firefox
   does not ship. The floating origin is what carries those cases.
4. **Distant-body rescale.** Anything past 1e8 m is drawn at 1e8 m and scaled by
   the same factor, which preserves angular size exactly and keeps Neptune
   inside the far plane.

The frame is equatorial rather than ecliptic for one reason: the HYG catalogue,
`HelioVector`, `GeoMoon`, `JupiterMoons` and `RotationAxis` are all already in
it, so nothing in this project ever converts between frames.

### Approaching a body

Two things have to be true for a planet to feel like it is being approached,
and neither is a rendering detail.

**It has to be visible before it is a disc.** A planet is one of the brightest
things in the sky long before it resolves: Jupiter at opposition is magnitude
-2.7, brighter than Sirius. So every body is also drawn as a point source, and
its brightness is its real apparent magnitude, computed from albedo, phase
angle and both distances. The point and the disc crossfade between about 1.5
and 5 pixels of angular size.

Below that, the point brightens as the inverse square of distance, so it keeps
getting brighter all the way in. Above it, the disc does not: a surface's
radiance does not depend on how far away you are, which is why the Moon is not
brighter from low orbit than from the ground. What grows is the solid angle, so
the total light still rises as the inverse square. Auto-exposure then stops
down as the planet fills the frame, exactly as an eye does.

The join between those two scales is derived, not chosen, in
`src/stars/pointFlux.ts`. Getting it wrong is invisible in code and glaring on
screen: the first version used a hand-picked constant that was off by a factor
of 4,480, so a planet brightened all the way in and then fell off a cliff the
moment it resolved.

**It must not be crossed in one frame.** The throttle spans nineteen orders of
magnitude, so without a limit the last five astronomical units of a journey
happen between two frames. Speed is capped at the distance remaining, divided
by two seconds. Because the cap is recomputed from the shrinking gap, the
approach is exponential: it cannot overshoot, since the speed reaches zero as
the distance does. Earth to Mars at full throttle takes about twenty-five
seconds, and the ship cuts its own throttle on arrival.

The selected target is treated far more generously than anything else. Its cap
uses true range and applies at any forward angle, because flying at your own
target is the entire loop. Everything else uses along-track distance inside a
corridor that is the wider of 120 radii and a three degree cone, so nothing
slows for a planet it has already passed or will miss by a wide margin.

Departing is not the same problem as arriving, so the clamp is four times
weaker when the nearest body is behind the nose. Without that, climbing out of
low orbit took ten seconds with the destination visibly no closer.

**Aim decides arrival, not speed.** A heading one degree out at 1.75 AU misses
Mars by 4.6 million kilometres, and no speed clamp can fix that: the ship
simply never gets closer than the miss distance. So with a target selected and
the throttle open, the ship steers onto it at a limited rate whenever the pilot
is not steering. Any pointer movement overrides it instantly, and it can be
turned off under **View**.

### The light pipeline

Realism here comes from the light pipeline, not from texture resolution.
Nothing is tuned by eye: everything is expressed against one reference, the
radiance of a fully lit white Lambertian surface at 1 AU, which is 1.0. On that
scale the solar disc is about 46,000 and a magnitude 6.5 star is about 2e-4.

Linear HDR throughout, tone mapped exactly once at the end with AgX. Ambient
light is zero and there is one light, the Sun, so shadows are black and the
terminator is sharp. Apollo photographs look like this.

Auto-exposure is the single biggest realism win, and the estimator took three
attempts. See the comment at the top of `src/render/exposure.ts`: the short
version is that a log average over a mostly black frame runs away, and the
luminance-weighted mean does not.

### Data

| What | Source | License |
|---|---|---|
| Stars | HYG database v4.4 | CC BY-SA 4.0 |
| Planet positions | astronomy-engine | MIT |
| Textures | Solar System Scope | CC BY 4.0 |
| Messier objects | SIMBAD (CDS Strasbourg) | free to use with credit |

Full attribution is in [CREDITS.md](./CREDITS.md) and on the in-app credits
screen.

**The star data is share-alike.** It lives in `public/data/stars/` with its own
`LICENSE`, and adaptations of it inherit CC BY-SA 4.0. Do not generate a
TypeScript file full of star literals: that would pull the share-alike term
into the source tree. The rest of the repository is Apache-2.0.

### Rebuilding the data

Only needed if you want to change the pipeline. Requires ImageMagick
(`brew install imagemagick`) for texture decoding and resizing.

```bash
npm run data           # everything below, in order
npm run data:fetch     # download and verify every source against its SHA-256
npm run data:stars     # HYG CSV to a packed 20-byte-per-star binary
npm run data:messier   # SIMBAD query to messier.json
npm run data:textures  # decode, resize and encode to KTX2
npm run data:basis     # copy the Basis transcoder into public/basis
```

Every upstream file is pinned by hash in `tools/sources.mjs`. The texture site
is a CMS with no versioning, so a hash is the only thing between a rebuild and
silently different art.

## Things that will bite you

Six real bugs, all found by taking a screenshot rather than by reading the code.
They are recorded here because every one of them is the kind that fails
silently.

- **`instancedBufferAttribute` is not instanced.** In three.js r186 it only
  marks `mat3` and `mat4` attributes as instanced; for a `vec3` or `vec4` it
  falls through and steps per vertex. All 109,000 stars read the same four rows
  and collapsed into one streak across the sky. Pass a real
  `InstancedBufferAttribute` and the node constructor picks it up.
- **`THREE.Points` cannot have a per-point size** on either backend, which is
  why the star field is instanced sprites.
- **The flag is `reversedDepthBuffer`**, renamed from `reverseDepthBuffer` in
  r179. The old spelling does nothing and warns about nothing.
- **KTX2Loader's transcoder URL breaks in Vite dev.** It resolves against the
  optimised dependency cache, Vite answers the 404 with `index.html`, and the
  only symptom is `Uncaught SyntaxError: Unexpected identifier 'html'` with no
  mention of textures. Hence `public/basis/` and an explicit transcoder path.
- **Compositing the sky by alpha does not work.** Whether a pass clears to
  alpha 0 or 1 depends on the renderer's clear alpha and the canvas, and when
  it comes out as 1 the stars are multiplied by zero. Depth has no such
  ambiguity.
- **The cockpit has to be rotated by the ship.** The camera sits at the origin
  and turns, so a cockpit left in world orientation is an object the camera
  swings around inside.
- **A full-screen HUD layer will eat every pointer event.** `#overlay > *`
  outranks `.hud { pointer-events: none }` on ID specificity, so the flight
  controls silently stopped working while the keyboard kept going. There is now
  a start-up hit test that names whatever is covering the canvas.
- **Padding on an overlay moves everything absolutely positioned inside it.**
  Children are placed against the padding box, so the target marker and the
  reticle sat a gutter away from the things they were marking. Anything that
  tracks a world position has to be positioned against the viewport.
- **A logarithmic throttle needs a legible scale.** Nineteen decades means the
  band that crosses the solar system in a watchable time is about a tenth of
  the travel: a quarter of the way along is 137 km/s, which is three weeks to
  Mars, and it looks like a quarter of the way to fast. The bar now has decade
  marks, and `Space` skips the guessing.
- **Every brightness has to be on one scale, including the sky.** The Milky Way
  panorama started on a hand-set gain three million times its real surface
  brightness. Once the exposure was pinned to the naked-eye star limit, deep
  space rendered as a blank white screen. It is now derived from 20.5
  magnitudes per square arcsecond and the panorama's measured peak.
- **You cannot show a faint star and a lit instrument panel at once.** The
  range between them is 57,000 to one. Real cockpits dim their instruments at
  night, and so does this one: the panels hold a constant display value as the
  exposure opens, capped at their physical luminance so they still wash out
  against a sunlit planet.
- **A projected position is meaningless behind the camera.** The perspective
  divide is by a negative w, so the coordinates flip sign, and an off-screen
  arrow driven from them wanders across the screen as the ship turns away from
  its target. The bearing is computed in camera space instead, where the sign
  of z says plainly which side the target is on. See `screenBearing`.

## Out of scope

Terrain landing, multiplayer, accounts, combat, trading, missions, procedural
planets around other stars, and time acceleration. Terrain level of detail
alone is a larger job than everything here, and Mars at full MOLA resolution is
463 m per pixel, so low flight would look smooth and bland however much effort
went into it. That is a data limit, not an engineering one.

## Questions or contributions

Issues and PRs aren't open to the public on this repo, but we'd love to hear from
you. Email [contact@mru.space](mailto:contact@mru.space).

## License

Source code under [Apache License 2.0](./LICENSE). The **Mru** name and mark are
trademarks; see [TRADEMARK.md](./TRADEMARK.md). Bundled data and textures carry
their own licenses, listed in [CREDITS.md](./CREDITS.md).
