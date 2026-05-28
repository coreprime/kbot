// Shared sea-surface + seabed math.  Included by every shader that has
// to agree on the wave height field or the seabed displacement:
//
//   * main.vert / main.frag - hull refraction warp, sea bounce on hull
//   * ground.vert / ground.frag - wave geometry + seabed rocks + caustics
//
// Editing here ripples to all of them, which is the entire point: the
// crest silhouette in the vertex shader and the per-pixel normal in the
// fragment shader stay in lock-step.

// Hash + value noise helpers - shared between the sea (for domain
// warping the wave field so it doesn't read as a sinusoid grid)
// and the seabed (for rock placement).  Standard prime-vector
// hash, smoothstep-interpolated value noise.
float seaHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float seaNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = seaHash(i);
  float b = seaHash(i + vec2(1.0, 0.0));
  float c = seaHash(i + vec2(0.0, 1.0));
  float d = seaHash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// seaWaveHS: 5-octave wave field with prime-ratio frequencies and
// cross-axis interference, then domain-warped by value noise so
// the surface never reads as a tiled grid of sines.  Peak
// amplitude is around 2.6 wu - tall enough to produce visible
// cresting and breaking foam, low enough that a battleship still
// sits on rather than under the wave.
vec3 seaWaveHS(vec2 xzIn, float t) {
  // Domain warp - perturb the input coordinates by value noise so
  // the underlying sine pattern stops aligning to a grid.  Two
  // octaves of warp give large-scale flow plus fine breakup; the
  // time term lets the warp itself drift slowly with the swell.
  vec2 wA = vec2(seaNoise(xzIn * 0.035 + t * 0.03),
                 seaNoise(xzIn * 0.035 - t * 0.02 + 17.3)) - 0.5;
  vec2 wB = vec2(seaNoise(xzIn * 0.12 + t * 0.06 + 3.7),
                 seaNoise(xzIn * 0.12 - t * 0.05 + 9.1)) - 0.5;
  vec2 xz = xzIn + wA * 18.0 + wB * 5.0;
  // Five spatial scales.  Each octave gets its own offset so the
  // beat pattern between layers shifts the "interesting" parts of
  // the surface around as time progresses.
  vec2 p1 = xz * 0.085;   // long primary swell (~74 wu wavelength)
  vec2 p2 = xz * 0.21;    // secondary swell (~30 wu)
  vec2 p3 = xz * 0.46;    // chop (~14 wu)
  vec2 p4 = xz * 1.05;    // small chop (~6 wu)
  vec2 p5 = xz * 2.40;    // capillary detail (~2.6 wu)
  // Octave 1 - two crossing components, slightly off-perpendicular
  // so the long swell isn't axis-aligned.  Largest amplitude ->
  // dominates the silhouette.
  float A1a = sin(p1.x * 0.97 + p1.y * 0.21 + t * 0.42);
  float A1b = sin(p1.y * 1.05 - p1.x * 0.18 - t * 0.36);
  // Octave 2 - different direction.
  float A2a = sin(p2.x * 0.78 - p2.y * 0.62 + t * 0.80);
  float A2b = sin(p2.x * 0.21 + p2.y * 0.93 - t * 0.72);
  // Octave 3 - chop with stronger time variation; crossing makes
  // wave crests look broken rather than parallel.
  float A3a = sin(p3.x * 1.13 + p3.y * 0.71 + t * 1.55);
  float A3b = sin(p3.x * 0.42 - p3.y * 1.07 + t * 1.30);
  // Octave 4 - small wavelets that put texture into the surface.
  float A4a = sin(p4.x * 1.31 + p4.y * 0.87 + t * 2.30);
  float A4b = sin(p4.x * 0.55 - p4.y * 1.21 + t * 2.65);
  // Octave 5 - capillary glitter (negligible height contribution,
  // matters mostly for the per-pixel normal).
  float A5a = sin(p5.x * 0.93 + p5.y * 0.47 + t * 3.85);
  float A5b = sin(p5.x * 0.27 - p5.y * 1.11 + t * 4.20);
  // Slowly varying "gust" envelope: large patches of rougher water
  // drift around the scene so the sea is more turbulent in some
  // areas than others.  Range 0.55..1.75 - average wave near
  // current amplitude, but pockets ~3x as tall (real cresting).
  float gust = 1.0
             + 0.35 * sin(xz.x * 0.018 + t * 0.13) * cos(xz.y * 0.020 - t * 0.10)
             + 0.25 * sin((xz.x + xz.y) * 0.013 + t * 0.07)
             + 0.15 * cos(xz.x * 0.031 - xz.y * 0.024 + t * 0.19);
  gust = clamp(gust, 0.55, 1.75);
  // Pure-noise layer mixed in directly - breaks the residual sine
  // banding when the sinusoid octaves happen to constructively
  // interfere.  Centered on 0 so it doesn't bias the mean height.
  float noiseLayer = (seaNoise(xz * 0.18 + t * 0.06) - 0.5) * 0.45
                   + (seaNoise(xz * 0.55 - t * 0.04 + 11.0) - 0.5) * 0.20;
  float h = (A1a * 0.55 + A1b * 0.55
          + A2a * 0.42 + A2b * 0.32
          + A3a * 0.22 + A3b * 0.18
          + A4a * 0.10 + A4b * 0.10
          + A5a * 0.03 + A5b * 0.03
          + noiseLayer) * gust;
  // Slope: chain-rule each component.  freqs were declared above so
  // the partials follow directly - keep these in sync if the
  // amplitudes/frequencies change.
  float dhx = cos(p1.x * 0.97 + p1.y * 0.21 + t * 0.42) * 0.97 * 0.085 * 0.55
            + cos(p1.y * 1.05 - p1.x * 0.18 - t * 0.36) * (-0.18) * 0.085 * 0.55
            + cos(p2.x * 0.78 - p2.y * 0.62 + t * 0.80) * 0.78 * 0.21 * 0.42
            + cos(p2.x * 0.21 + p2.y * 0.93 - t * 0.72) * 0.21 * 0.21 * 0.32
            + cos(p3.x * 1.13 + p3.y * 0.71 + t * 1.55) * 1.13 * 0.46 * 0.22
            + cos(p3.x * 0.42 - p3.y * 1.07 + t * 1.30) * 0.42 * 0.46 * 0.18
            + cos(p4.x * 1.31 + p4.y * 0.87 + t * 2.30) * 1.31 * 1.05 * 0.10
            + cos(p4.x * 0.55 - p4.y * 1.21 + t * 2.65) * 0.55 * 1.05 * 0.10
            + cos(p5.x * 0.93 + p5.y * 0.47 + t * 3.85) * 0.93 * 2.40 * 0.03
            + cos(p5.x * 0.27 - p5.y * 1.11 + t * 4.20) * 0.27 * 2.40 * 0.03;
  float dhz = cos(p1.x * 0.97 + p1.y * 0.21 + t * 0.42) * 0.21 * 0.085 * 0.55
            + cos(p1.y * 1.05 - p1.x * 0.18 - t * 0.36) * 1.05 * 0.085 * 0.55
            + cos(p2.x * 0.78 - p2.y * 0.62 + t * 0.80) * (-0.62) * 0.21 * 0.42
            + cos(p2.x * 0.21 + p2.y * 0.93 - t * 0.72) * 0.93 * 0.21 * 0.32
            + cos(p3.x * 1.13 + p3.y * 0.71 + t * 1.55) * 0.71 * 0.46 * 0.22
            + cos(p3.x * 0.42 - p3.y * 1.07 + t * 1.30) * (-1.07) * 0.46 * 0.18
            + cos(p4.x * 1.31 + p4.y * 0.87 + t * 2.30) * 0.87 * 1.05 * 0.10
            + cos(p4.x * 0.55 - p4.y * 1.21 + t * 2.65) * (-1.21) * 1.05 * 0.10
            + cos(p5.x * 0.93 + p5.y * 0.47 + t * 3.85) * 0.47 * 2.40 * 0.03
            + cos(p5.x * 0.27 - p5.y * 1.11 + t * 4.20) * (-1.11) * 2.40 * 0.03;
  // Scale slopes by the same gust factor so the wave normal stays
  // consistent with the displaced height (otherwise crests get
  // gentle normals at the same time their geometry is doubled).
  return vec3(h, dhx * gust, dhz * gust);
}

// seaCaustic: the dancing sun-net on the seabed.  Three offset
// sinusoid sums clamped through smoothstep produce a tessellated
// caustic pattern that pulses with time.  Shared by the seabed
// pass (paint on rocks) and the main shader (bounce light onto
// the unit's hull).
float seaCaustic(vec2 xz, float t) {
  vec2 cp = xz * 0.55;
  float c1 = abs(sin(cp.x + t * 0.55) + sin(cp.y * 0.95 - t * 0.6) + sin((cp.x + cp.y) * 0.6 + t * 0.4));
  float c2 = abs(sin(cp.x * 1.4 - t * 0.5) + sin(cp.y * 1.1 + t * 0.7) + sin((cp.x - cp.y) * 0.8 - t * 0.45));
  float caustic = 1.0 - smoothstep(0.2, 2.0, min(c1, c2));
  return pow(caustic, 1.4);
}

// seabedHeight: hash-grid placed rocks + low-freq dunes.  The same
// function runs in both the seabed vertex shader (for displacement)
// and the water surface shader (so the water alpha tracks how
// shallow the bed is at that point, exposing the rocks through the
// surface).  Three knobs let the UI dial the look:
//
//   heightMul    - multiplier on dune + rock peak height (default 1.0)
//   scale        - XZ wavelength multiplier; >1 stretches features
//                  out for fewer, larger rocks; <1 packs them tighter
//                  (default 1.0)
//   rockChance   - probability a hash cell spawns a rock (default 0.12)
//                  0 -> dune-only smooth bed, 1 -> carpeted outcrops
float seabedHeight(vec2 xz, float heightMul, float scale, float rockChance) {
  float fScale = scale > 0.0001 ? scale : 1.0;
  // Large dunes - XZ wavelength stays around 0.0025 by default; the
  // scale slider divides the input coordinate so larger scale =
  // stretched features.
  vec2 dp = (xz / fScale) * 0.0025;
  float dune = sin(dp.x * 0.9 + 0.4) * cos(dp.y * 1.1 - 0.7) * 8.00 * heightMul
             + sin(dp.x * 1.7 - dp.y * 0.6 + 1.9) * 4.80 * heightMul
             + sin(dp.x * 0.4 + dp.y * 0.3 + 5.2) * 7.20 * heightMul;
  // Hash-cell rock peaks - cells massively bigger (18 -> 180 wu)
  // so the "leopard spot" repetition disappears at typical
  // viewing distances.  Cell size scales with the same slider so
  // bigger rocks come in fewer cells without piling up density.
  float cellSize = 180.0 * fScale;
  vec2 cell = floor(xz / cellSize);
  vec2 cf = fract(xz / cellSize);
  float h0 = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5);
  float h1 = fract(sin(dot(cell, vec2(269.5,  183.3))) * 17483.5);
  float h2 = fract(sin(dot(cell, vec2(419.2,  371.9))) * 28197.7);
  float present = step(1.0 - clamp(rockChance, 0.0, 1.0), h0);
  vec2 centre = vec2(h1, h2) * 0.6 + 0.20;
  float dist = length(cf - centre);
  float radius = 0.28 + h1 * 0.30;
  float peakH = (8.0 + h2 * 16.0) * heightMul;
  float rock = present * peakH * smoothstep(radius, 0.0, dist);
  return dune + rock;
}

// Convenience overload preserving the pre-feature defaults so the
// rest of the codebase compiles unchanged.  When the UI plumbing
// passes the explicit form above, this fallback is bypassed.
float seabedHeight(vec2 xz) {
  return seabedHeight(xz, 1.0, 1.0, 0.12);
}
