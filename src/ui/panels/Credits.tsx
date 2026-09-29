/**
 * Credits.
 *
 * Not optional. The HYG catalogue is share-alike and the Solar System Scope
 * textures are attribution, so both are required terms rather than courtesy.
 * NASA and SIMBAD do not require credit; they get it anyway.
 */

export const Credits = ({ onClose }: { onClose: () => void }): React.ReactElement => (
  <div className="panel sheet" role="dialog" aria-label="Credits">
    <div className="sheet-head">
      <span className="sheet-title">Credits and licences</span>
      <button className="chip" onClick={onClose}>Close</button>
    </div>
    <div className="sheet-body credits">
      <h3>Star positions</h3>
      <p>
        HYG Database v4.4 by David Nash (astronexus), a merge of Hipparcos, Yale
        Bright Star and Gliese. 109,389 stars at their catalogued distances,
        magnitudes and colour indices.
        {' '}<a href="https://codeberg.org/astronexus/hyg" target="_blank" rel="noreferrer">codeberg.org/astronexus/hyg</a>
        {' — '}licensed{' '}
        <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>.
        The data files served by this site are adaptations of it and carry the
        same licence.
      </p>

      <h3>Planet positions</h3>
      <p>
        astronomy-engine by Don Cross, a pure JavaScript VSOP87 implementation,
        MIT licensed.
        {' '}<a href="https://github.com/cosinekitty/astronomy" target="_blank" rel="noreferrer">github.com/cosinekitty/astronomy</a>
      </p>

      <h3>Textures</h3>
      <p>
        Planet, Sun, ring and sky maps by{' '}
        <a href="https://www.solarsystemscope.com/textures/" target="_blank" rel="noreferrer">Solar System Scope</a>,
        licensed{' '}
        <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>.
        Changes made: resized, transcoded to KTX2, and the sky panorama was
        blurred so its baked-in stars do not double up against the catalogue.
      </p>

      <h3>Deep sky objects</h3>
      <p>
        Messier positions and distances from SIMBAD, operated by CDS,
        Strasbourg Astronomical Observatory, France.
      </p>

      <h3>Software</h3>
      <p>
        three.js (MIT). Basis Universal transcoder (Apache-2.0), by Binomial LLC.
      </p>

      <h3>This project</h3>
      <p>
        Mru 2049. Source code Apache-2.0. The Mru name and mark are trademarks;
        see TRADEMARK.md in the repository.
      </p>
    </div>
  </div>
)
