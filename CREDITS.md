# Credits and licences

Mru 2049 is built almost entirely on other people's work. Two of the licences
below are obligations rather than courtesies, and one of them is share-alike.

## Star positions

**HYG Database v4.4**, by David Nash (astronexus). A merge of the Hipparcos,
Yale Bright Star and Gliese catalogues. This project uses 109,389 of its rows
at their catalogued distances, absolute magnitudes and colour indices.

- <https://codeberg.org/astronexus/hyg>
- Licence: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

**This is a share-alike licence and it reaches the files derived from it.**
`public/data/stars/stars.bin`, `star-ids.bin` and `star-names.json` are
adaptations of the HYG database and are distributed under CC BY-SA 4.0. They
sit in their own directory with their own `LICENSE` file so the obligation
stays contained. The source code of this project is Apache-2.0 and is not
affected.

Changes made: rows were filtered (the Sun, and rows carrying the
unknown-parallax placeholder distance, were removed), the remainder was
repacked into a fixed 20-byte binary layout, and the B-V colour index was
converted to a linear sRGB triple.

## Planet positions

**astronomy-engine**, by Don Cross. A pure JavaScript implementation of VSOP87
and the IAU rotation models, accurate to roughly an arcminute over 1900 to
2100.

- <https://github.com/cosinekitty/astronomy>
- Licence: MIT

## Textures

**Solar System Scope**. Planet, Sun, ring and sky maps.

- <https://www.solarsystemscope.com/textures/>
- Licence: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

Changes made, which CC BY 4.0 requires be noted:

- resized and transcoded to KTX2 with Basis Universal compression;
- the sky panorama was blurred, so that the stars baked into the photograph do
  not double up against the 109,389 catalogue sprites drawn over it;
- each colour map's overall level was scaled so its mean linear reflectance
  matches the body's published geometric albedo. The maps are prepared to look
  right on a screen rather than to measure reflectance, so Earth's day map
  averages 0.219 where the planet's albedo is 0.434, and the Moon's averages
  0.326 where the real figure is 0.136.

## Deep sky objects

**SIMBAD**, operated by CDS, Strasbourg Astronomical Observatory, France.
Positions and distances for the 110 Messier objects.

- <https://simbad.u-strasbg.fr/simbad/>
- Wenger et al. (2000), "The SIMBAD astronomical database", A&AS 143, 9.

## Software

**three.js** — rendering. MIT.
<https://threejs.org/>

**Basis Universal** transcoder, by Binomial LLC — KTX2 texture decoding in the
browser. Apache-2.0. The two transcoder files in `public/basis/` are
redistributed unmodified from three.js.
<https://github.com/BinomialLLC/basis_universal>

**ktx2-encoder** — a WebAssembly build of Basis Universal used at build time.
MIT.

**React**, **Vite**, **Vitest**, **TypeScript**, **ESLint** — MIT.

**ImageMagick** — build-time texture decoding and resizing. Not shipped.
Apache-2.0-style ImageMagick licence.

## Reference values

Physical constants, body radii, gravitational parameters and albedos are from
the IAU and the NASA/JPL planetary fact sheets. Rayleigh optical depths are
standard values for the relevant wavelengths. The B-V to temperature relation
is Ballesteros (2012), "New insights into black bodies", EPL 97, 34008. The CIE
1931 colour matching functions are the analytic fit from Wyman, Sloan and
Shirley (2013), "Simple Analytic Approximations to the CIE XYZ Color Matching
Functions", JCGT 2(2).

None of these require attribution. They are listed because knowing where a
number came from is the difference between a physical model and a tuned one.

## This project

**Mru 2049**. Source code under [Apache License 2.0](./LICENSE).

**Mru™**, **Mru 2049™** and the Mru logo are trademarks of Binns Pte. Ltd.
Apache 2.0 section 6 does not grant rights to them; see
[TRADEMARK.md](./TRADEMARK.md).
