/**
 * Art direction, as data.
 *
 * Every colour and every post-processing weight in the game lives here. The point
 * is that the look is one file rather than a hunt through six: if a colour reads
 * muddy on a phone screen in daylight, this is the only file that needs to
 * change, and the change is a number rather than a search.
 *
 * Presentational and client-only. Nothing on the determinism path imports this,
 * and the server never sees it -- the course ships as raw JSON and the art
 * direction is applied on arrival.
 */

/**
 * The palette.
 *
 * Fifteen tokens, dark to light, as given. Held in a single object rather than
 * scattered through the code so the ramp can be read top to bottom as one system:
 * four near-blacks build the environment, five saturated mid-tones carry the
 * brand, and five pastels are the only things allowed to be genuinely bright.
 *
 * That last split is the rule that keeps this from turning into neon soup. The
 * pastels are not decoration — they are *load-bearing*. Anything large and close
 * is painted in the dark half; anything you are meant to read as light is in the
 * pastel half. If a mid-tone purple ever needs to glow, it gets promoted to a
 * pastel first rather than being turned up.
 *
 * This replaces an earlier ramp lifted from the Monad Metropolis site. That one
 * is gone entirely — nothing in the game still refers to it, so the provenance
 * comment that used to live here has been deleted rather than left to rot.
 */
export const RAMP = {
  /** Main background. Also the fog colour and the CSS page colour. */
  black: 0x020202,
  /** Secondary dark areas. Course bodies. */
  charcoal: 0x100f13,
  /** Background transition. */
  darkPurple: 0x201c29,
  /** Lower background. The bottom stop of every vertical gradient. */
  deepViolet: 0x2c1a57,
  /** Main purple. The technical grid. */
  purple: 0x482285,
  /** Bright purple accents. */
  magentaPurple: 0xb35bf7,
  /** Soft purple surfaces. */
  lavender: 0xc69dfa,
  /** Blue-purple elements. */
  periwinkle: 0x808ff9,
  /** Cyan/blue surfaces. */
  lightBlue: 0x9ec7fa,
  /** Bright blue accents. */
  cyanBlue: 0x4eabe8,
  /** Pink surfaces. */
  pink: 0xf086b8,
  /** Pastel pink. */
  lightPink: 0xf7aee0,
  /** Typography and highlights. A cool white, never pure #fff. */
  white: 0xf4fafc,
  /** Yellow/cream accents. Also the airborne cue. */
  cream: 0xead2a9,
  /** Red/pink shadows. */
  crimson: 0x781649,
} as const;

/**
 * The signature gradient.
 *
 * Stops rather than a CSS string, because the 3D side needs the individual
 * colours and having the 3D ramp and the CSS drift apart would be a subtle way
 * to lose the identity. `style.css` hardcodes the same four stops and says so.
 *
 * Periwinkle to lavender to pastel pink to cool white, on a 105 degree axis.
 * Note it *ends* on the lightest stop rather than fading back out — the earlier
 * Metropolis gradient returned to its starting colour at both ends, which works
 * when the ends are the same colour. Here the ends are not, and fading out would
 * just make the middle of a headline invisible against a near-black page.
 */
export const SIGNATURE = [
  { at: 0, color: RAMP.periwinkle },
  { at: 0.36, color: RAMP.lavender },
  { at: 0.68, color: RAMP.lightPink },
  { at: 1, color: RAMP.white },
] as const;

/**
 * The dark half of the palette.
 *
 * `base` doubles as the background, the fog colour and the CSS page background.
 * They must be the same value: against a near-black sky, any mismatch between
 * fog and background draws a horizon line, and that line is the first thing the
 * eye finds in a dark scene.
 *
 * `black` is not pure #000000. A value of 2 rather than 0 is what keeps the
 * deepest shadow from clipping to a flat void — pure black has no gradient left
 * in it, so nothing in the image can be darker than anything else and the
 * scene reads as a hole rather than as darkness.
 */
export const PALETTE = {
  /** Background, fog and page colour, all one value. See above. */
  base: RAMP.black,

  /**
   * Course geometry.
   *
   * Charcoal against a black background is a narrow gap, which is the point:
   * the pads are found by their lit edges, not by their fill. Anything brighter
   * here starts competing with the far-field platforms for the player's eye, and
   * the track has to win that.
   */
  mass: RAMP.charcoal,

  /**
   * The technical grid on the ground plane.
   *
   * Main purple, but it only reads because the fog eats it: unattenuated, this
   * is a fairly saturated violet, and across a 900-unit plane it would be the
   * loudest thing on screen. By the grid's far edge it is gone entirely.
   */
  grid: RAMP.purple,
} as const;

/**
 * The neon ramp.
 *
 * Iridescent accents, used sparingly. The discipline that keeps this from reading
 * as cyberpunk is that neon appears on *edges and the player's own capsule*,
 * never as a surface colour on architecture -- the architecture stays dark and
 * the light only describes its outline.
 *
 * Every member is a pastel from `RAMP`, never a mid-tone. These are emissive and
 * have to clear the bloom threshold on a near-black scene; a saturated
 * `#482285` would simply not show.
 *
 * `cream` is not a brand accent. It is here because the grounded/airborne colour
 * cue was amber in every previous build, and warm cream is the closest token in
 * this ramp to what amber meant. It keeps reading the same way instead of
 * silently changing what the cue tells the player.
 *
 * `blue` replaces the `green` this ramp used to have. The palette contains no
 * green at all, so the member had to go rather than be pointed at the nearest
 * available hue — naming a colour `green` when it is `#9EC7FA` is the kind of
 * small lie that costs an hour three months later.
 */
export const NEON = {
  violet: RAMP.magentaPurple,
  magenta: RAMP.pink,
  cyan: RAMP.cyanBlue,
  blue: RAMP.lightBlue,
  amber: RAMP.cream,
  white: RAMP.white,
} as const;

/**
 * Racer identity colours. Deliberately OUTSIDE the pastel ramp.
 *
 * The arena and UI stay pastel, and that is exactly why racers must not: a
 * racer has to be the most saturated thing in their patch of screen, so the
 * eye finds people before it finds architecture. Electric, fully saturated
 * hues, spaced around the wheel so six racers stay tellable apart in motion.
 *
 * White is excluded on purpose -- it is the Core carrier's cue.
 */
export const RACER = {
  hotPink: 0xff2fb9,
  cyan: 0x00e1ff,
  electricBlue: 0x3a6bff,
  acid: 0xb8ff2e,
  violet: 0xa24bff,
  orange: 0xff8a1f,
} as const;

/** Identity order: the local racer takes the first, remotes cycle the rest. */
export const RACER_IDENTITY: readonly number[] = [
  RACER.hotPink,
  RACER.cyan,
  RACER.electricBlue,
  RACER.acid,
  RACER.violet,
  RACER.orange,
];

/**
 * Which set of post weights and emissive gains to use.
 *
 * Not a taste distinction — a budget one. The WebGL2 fallback on a phone cannot
 * afford the same per-pixel cost as WebGPU on a desktop GPU, and a 2000-nit
 * phone screen in daylight needs more contrast than a calibrated monitor before
 * anything reads as dark.
 *
 * `mobile` is therefore *not* just `desktop` with fewer effects. It trades
 * vignette and grain — which are cheap but sum to real fill rate — for a higher
 * bloom threshold and more emissive gain, which costs nothing because those
 * pixels are already being shaded. The scene ends up less atmospheric and
 * punchier, which is the right trade on a 6" screen at arm's length.
 *
 * Detection is in `pickScheme()` and is deliberately coarse. Guessing wrong just
 * means the game looks slightly different from ideal, and the user can override
 * it from the console.
 */
export type SchemeName = 'desktop' | 'mobile';

export interface Scheme {
  /** Bloom weights. */
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  /** Film grain amplitude. */
  grain: number;
  /** Static dither amplitude. */
  dither: number;
  /** Corner darkening. */
  vignette: number;
  /** Vignette falloff exponent. Higher keeps the darkening further out. */
  vignettePower: number;
  /** Noise cells across the screen. Higher = finer grain. */
  grainScale: number;
  /**
   * Grain resamples per second, independent of frame rate.
   *
   * A 60fps render showing 60 distinct grain fields reads as digital noise.
   * Real film grain runs on the projector, not the shutter, so stepping this
   * below the frame rate looks like film rather than like static.
   *
   * Shared by both schemes: the *rate* is a look decision, not a budget one.
   */
  grainHz: number;
  /** Tone-mapping exposure. */
  exposure: number;
  /** Multiplier on the racers' emissive rim. */
  emissiveGain: number;
  /** Multiplier on the course's neon edge lines. */
  edgeGain: number;
}

export const SCHEMES: Record<SchemeName, Scheme> = {
  desktop: {
    bloomStrength: 0.85,
    bloomRadius: 0.7,
    bloomThreshold: 0.55,
    grain: 0.035,
    dither: 0.006,
    vignette: 0.85,
    vignettePower: 1.6,
    grainScale: 640,
    grainHz: 24,
    exposure: 1.15,
    emissiveGain: 2.4,
    edgeGain: 1.7,
  },
  mobile: {
    // Higher threshold, because a phone at full brightness blooms its own
    // highlights optically. Lowering it too makes the whole image glow.
    bloomStrength: 0.7,
    bloomRadius: 0.55,
    bloomThreshold: 0.72,
    grain: 0.022,
    dither: 0.006,
    // Dropped hard. A vignette on a small screen eats the thing the player is
    // supposed to be looking at, which is the racer a few metres away.
    vignette: 0.45,
    vignettePower: 1.9,
    // Coarser than desktop. Finer grain at typical phone DPI reads as sensor
    // noise rather than as film.
    grainScale: 420,
    grainHz: 24,
    exposure: 1.3,
    emissiveGain: 3.1,
    edgeGain: 2.1,
  },
};

/**
 * Pick a scheme for this device.
 *
 * Coarse on purpose: WebGPU availability decides the budget, and a coarse
 * pointer is the second signal. Deliberately *not* checking screen size, because
 * a small desktop window would then get the mobile grade on a display that has
 * plenty of headroom.
 *
 * Override from the console with `pickScheme('mobile')` if this guesses wrong.
 */
export function pickScheme(preferred?: SchemeName): Scheme {
  if (preferred) return SCHEMES[preferred];

  const hasWebGPU = 'gpu' in navigator && navigator.gpu !== undefined;
  const coarse = globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;

  return hasWebGPU && !coarse ? SCHEMES.desktop : SCHEMES.mobile;
}

/**
 * Post-processing weights for the active scheme.
 *
 * A plain object rather than `as const`, because these are the numbers most
 * likely to need tuning after watching the game move, and `POST.grain = 0` from
 * the console is the intended workflow.
 *
 * Grain and dither are separated on purpose. They use the same noise primitive
 * but do different jobs, and conflating them means you cannot turn one off
 * without losing the other:
 *
 *   - `grain` is animated. It is the film texture, and it is what stops flat
 *     gradients from looking like flat CSS.
 *   - `dither` is static and much weaker. Its only job is to break up banding
 *     in the dark gradient at the top of the frame, where 8-bit output has
 *     visible steps. Turning grain off does not require turning this off.
 */
export const POST = pickScheme();

/**
 * Environment tuning: fog density and the grid.
 *
 * Separate from the colours because these are the two settings that decide
 * whether the scene reads as monumental or as small. Fog is what creates depth
 * in a scene with no sky detail to do it for you.
 */
export const ATMOS = {
  /**
   * Exponential-squared fog density.
   *
   * This number decides the entire look, so here is the arithmetic rather than a
   * vibe. FogExp2 blends by `1 - exp(-(density * distance)²)` — note the square.
   * It is not linear and it is not gentle: it stays nearly clear for the first
   * stretch and then falls off a cliff. At 0.009:
   *
   *     40m (the goal gate)   12.2% fogged  ← gate still clearly readable
   *     90m (near skyline)    48.1% fogged  ← towers read as silhouettes
   *    165m (far skyline)    89.0% fogged   ← barely there, which is the point
   *    450m (grid edge)      ~100%  fogged  ← grid dissolves, no visible edge
   *
   * That last row is why the grid plane can be finite: by the time you reach its
   * edge it is already the background colour, so there is no hard line to see.
   *
   * Dropped from 0.011 when the background became true black. The blend formula
   * did not change, but the *perceived* result did: a tower 48% fogged toward a
   * blue-tinted void still had a visible hue in it, and the same tower 48% fogged
   * toward `#020202` is simply dark. Density had to come down to keep the
   * far-field from vanishing.
   *
   * Two failure directions, and they are not symmetric. Raising this eats the
   * goal gate, which is the one thing a player must be able to see from the
   * start. Lowering it flattens the lane into a flat plane with no depth cue and
   * lets the skyline's far towers pop out at full contrast, which looks like a
   * matte painting rather than atmosphere.
   */
  fogDensity: 0.009,

  /** World units per grid tile. Small enough to read as technical. */
  gridTile: 10,
  /** Grid texture repeats per side. Large, so the plane never shows an edge. */
  gridRepeats: 60,
  /** Plane width, world units. Must exceed the fog's visible radius. */
  gridExtent: 900,
  /**
   * How far below the pads the grid sits.
   *
   * The pads' top faces are at y=0, so the grid has to clear them or it
   * z-fights. The gap is small enough to be invisible and large enough to be
   * safe; a bigger offset starts reading as the lane floating above a void,
   * which is a different (also defensible) look.
   */
  gridY: -0.05,
} as const;

/**
 * The far-field skyline.
 *
 * Purely decorative, and deliberately the cheapest thing in the render path.
 * Every tower is one instance of a single box in a single `InstancedMesh`, so
 * the whole city is one draw call regardless of how many towers there are.
 *
 * The heights are hand-set rather than random. Random towers produce visual
 * noise and no composition; a deliberate descending rhythm — a tall anchor left,
 * a gap, a cluster, a tall anchor right — reads as a skyline.
 */
export const SKYLINE = {
  /**
   * Tower count.
   *
   * Every tower is one instance in a single draw call, so this costs nothing in
   * draw calls and scales linearly in vertex cost — a unit cube is 24 vertices,
   * so 120 towers is under 3k vertices for the entire city. The real constraint
   * is legibility, not budget: past roughly 150 the fog cannot separate
   * individual towers and it becomes a grey wall.
   */
  count: 120,

  /**
   * Sideways distance band for the towers, world units.
   *
   * These numbers are set by the fog, not by taste, and getting them wrong makes
   * the whole feature invisible. See the fog arithmetic on `ATMOS.fogDensity`:
   * the band sits at 90–165, deliberately inside the radius where fog still
   * passes something through.
   */
  near: 90,
  far: 165,

  /**
   * How far the band stretches along the lane's axis, world units.
   *
   * Divided by `count`, this sets the spacing between consecutive towers along
   * Z: 900 / 120 = 7.5m against a 9m footprint, so neighbours overlap slightly.
   * That overlap is wanted — it is what turns a row of separate boxes into a
   * continuous city mass.
   *
   * Bounded by `CAMERA.far` (600): the furthest tower sits at roughly
   * `hypot(450, 165)` ≈ 479m, comfortably inside.
   */
  span: 900,

  /**
   * Whether the skyline is visible depends on camera pitch, and that is worth
   * knowing before someone files it as "the buildings did not load."
   *
   * The camera is a chase rig pitched *down* by default (`CAMERA.pitch`, 0.5 rad).
   * With `fov: 70`, the top edge of frame then sits only about 6° above the
   * horizontal — the horizon is a sliver at the very top of the image, and a
   * tower more than ~16m tall at 90m is already outside the frustum.
   *
   * So at the default pitch the skyline reads as monumental dark mass flanking
   * the lane and running off the top of frame. Pitch the camera down toward
   * `CAMERA.minPitch` (0.06 rad) and the whole skyline comes into view with its
   * lit crowns. Level camera = cinematic horizon.
   *
   * The alternative — lowering the default pitch so the skyline is always in
   * shot — was rejected: it flattens the racing view, and the lane reads worse
   * when you can see the horizon cutting across the pads.
   */

  /** Tower footprint, world units. Tall and thin reads as monumental. */
  width: 9,
  depth: 9,

  /**
   * Tower heights, in metres, repeated across the band.
   *
   * Hand-set rather than random, and kept here as data rather than in the
   * builder, because the *rhythm* is the composition. This descends from a tall
   * anchor, opens a gap, clusters, then rises to a tall right anchor.
   *
   * The tall end is bounded by framing rather than by taste. See the pitch note
   * above before raising anything past 190.
   */
  heights: [190, 132, 148, 96, 62, 78, 118, 54, 88, 172, 104, 66],

  /**
   * Crown colours, sampled per tower.
   *
   * All four are pastels, which matters: a crown is emissive and has to clear the
   * bloom threshold, so a mid-tone would simply never show. The rule from the top
   * of this file — dark half for mass, pastel half for light — is not advisory.
   */
  crownTints: [RAMP.lavender, RAMP.lightPink, RAMP.periwinkle, RAMP.lightBlue],

  /**
   * Fraction of towers that get a lit crown.
   *
   * Sparse on purpose. A fully lit skyline is a wall of light and reads as noise;
   * a handful of bright crowns against dark masses reads as a city.
   */
  litRatio: 0.34,

  /**
   * Emissive gain on a lit crown. Above 1 so it clears the bloom threshold.
   *
   * Deliberately *not* per-platform, unlike `Scheme.emissiveGain`. This one is
   * competing against fog that has already removed 50–90% of the tower's signal,
   * so it has to be aggressive to survive at all.
   */
  crownGain: 2.4,
} as const;

/**
 * The shapes the near-field platforms are cut from.
 *
 * Five silhouettes, deliberately far apart in aspect ratio so they never read as
 * the same object at different sizes:
 *
 *     slab    30 : 1.2 : 16    a plate, seen almost edge-on
 *     cube     1 :  1  :  1    the only closed volume in the scene
 *     column   1 :  3.4:  1    a mast
 *     puck    ~9 :  1  : ~9    a disc, the only round silhouette
 *     shard    1 :  1.5:  1    the only faceted one
 *
 * The aspect spread is the whole reason this list works. Three boxes at
 * different scales would still read as three boxes; a plate, a cube, a mast, a
 * disc and a shard read as five things, and that is what makes the near field
 * look built rather than populated.
 *
 * `kind` selects the geometry; `size` is the instance scale applied to a unit
 * primitive. Geometry construction lives in `skyline.ts` — this is proportions
 * and intent, which is art direction.
 */
export const SHAPES = {
  /**
   * Wide flat plate. The original platform, kept because it reads as a deck.
   *
   * 18 rather than the 30 this started at: width is a reachability constraint as
   * well as a look one, and the widest shape sets how close the whole field can
   * sit to the track. See `PLATFORMS.nearX`.
   */
  slab: { kind: 'box', size: [18, 1.2, 16] },
  /** Closed volume. Rare on purpose — one in five, so it lands as an event. */
  cube: { kind: 'box', size: [11, 11, 11] },
  /** Vertical mast. Breaks the horizontal bias of everything else. */
  column: { kind: 'box', size: [7, 24, 7] },
  /** Disc. The only round silhouette, and it catches the rim light differently. */
  puck: { kind: 'cyl', size: [19, 2.2, 19], segments: 20 },
  /** Faceted shard. The only shape that produces a hard specular glint. */
  shard: { kind: 'octa', size: [11, 16, 11] },
} as const;

export type ShapeName = keyof typeof SHAPES;

/**
 * Shape assignment order, cycled through the platform list.
 *
 * An explicit list rather than `i % 5` so the mix can be dialled without
 * touching code, and so the same shape never lands twice in a row — adjacent
 * repeats read as a mistake.
 */
export const SHAPE_CYCLE: readonly ShapeName[] = [
  'slab',
  'shard',
  'column',
  'slab',
  'puck',
  'cube',
  'column',
  'shard',
] as const;

/**
 * The vertical gradient painted onto every platform.
 *
 * Bottom to top: bright purple, lavender, then the platform's own pastel. Two
 * shared stops and one per-instance, so the whole field shares a family
 * resemblance while every platform still has its own top colour.
 *
 * The gradient runs vertically rather than across the face because the platforms
 * are mostly seen from a chase camera looking slightly down — a vertical ramp
 * stays legible at that angle where a horizontal one foreshortens into a band.
 *
 * It is normalised against each platform's **own** height rather than against a
 * global range, so a 1.2m plate and a 24m column get the same gradient in
 * proportion. Without that, every plate would be a single colour: they are too
 * thin to show a ramp in world space.
 *
 * The surface albedo is the platform's own pastel at full strength, fed in
 * through `instanceColor`. The gradient drives the emissive only. See `stops`
 * for why a single gain can cover the whole ramp, and `emissiveGain` for why
 * emissive rather than albedo is what makes these read as pastel.
 */
/**
 * The pastel neon gradient painted onto every platform.
 *
 * **Baked into vertex colours at build time, not computed per fragment.** An
 * earlier version computed this in the shader from `positionWorld.y` and a
 * per-instance `vec2` of the shape's bounds, with a chain of `mix` calls. It
 * rendered as black surfaces with a lit rim, three attempts at tuning did not
 * fix it, and the conclusion was that the graph itself was the suspect — it had
 * too many ways to fail quietly, and a shader that fails quietly looks exactly
 * like a shader that is working on a colour you did not expect.
 *
 * So the gradient is now four colours interpolated once per vertex and stored in
 * a `color` attribute. The shader does one thing: `vertexColor()`. Standard
 * three.js, no instanced attributes, no world-space math, no division, no mixes.
 *
 * Every stop is a pastel, and the *reason* is that these are emissive values and
 * the range has to be tight. Measured in linear luminance, a ramp that included
 * the palette's dark half spanned 28x — deep violet 0.020 against light blue
 * 0.550 — and no single gain serves both ends of that. One end was always a
 * black silhouette. These four span 2.3x, so one gain reads across the whole
 * ramp and the gradient varies hue rather than brightness.
 *
 * It ends on white, which is the lit edge: the brightest stop lands on the top
 * face of every shape, over the bloom threshold, while the base sits under it.
 * That gap is what reads as an outline.
 */
export const GRADIENT = {
  stops: [
    { at: 0.0, color: RAMP.lavender },
    { at: 0.42, color: RAMP.lightBlue },
    { at: 0.74, color: RAMP.lightPink },
    { at: 1.0, color: RAMP.white },
  ],

  /**
   * Emissive gain on the baked gradient.
   *
   * At 1.5 the ramp spans roughly 0.65 to 1.5 on screen, so the whole platform is
   * lit and the top face is well over the 0.55 bloom threshold. The dark end of
   * the old ramp bottomed out near 0.02, which is black; this one has no end
   * anywhere near it.
   *
   * If the platforms start stealing focus from the lane, this is the number to
   * come down — and unlike a scale applied to the gradient, lowering it dims
   * uniformly instead of crushing one end into nothing.
   */
  emissiveGain: 1.5,
} as const;

/**
 * Stacked platforms in the near-mid field, beside the lane.
 *
 * The skyline reads as a city on the horizon but gives the eye nothing at the
 * distances where the lane actually reads. These fill that gap: platforms cut
 * from five silhouettes, stacked at different heights, each tier topped out in a
 * different pastel.
 *
 * Decorative, like the towers. Not collidable, which is the whole risk here and
 * the reason `nearX` is set by arithmetic rather than by taste — see below.
 */
export const PLATFORMS = {
  /**
   * How many platforms per tier.
   *
   * Eight per tier over three tiers is 24, which over the shape cycle gives five
   * of each silhouette — enough that no shape reads as a singleton accident, few
   * enough that the near field never becomes a wall.
   */
  perTier: 8,

  /**
   * Closest lateral distance of any platform *centre*, world units.
   *
   * **This number is a gameplay constraint, not a visual one.** These platforms
   * have no collider, so anything the player can reach they will fall straight
   * through, which reads as a broken game rather than as scenery. Three terms,
   * and the third is the one that is easy to forget:
   *
   *     player's own radius                            0.4m
   *     pad half-width (the pads are 12 wide)           6.0m
   *     reach: airtime 2v/g = 18/26 = 0.69s, at sprint 12 m/s   8.3m
   *     ----------------------------------------------------------------
   *     nearest point a player can occupy                 14.7m
   *
   * Then the platform's own half-width is subtracted, because a shape 18 wide
   * centred at 30 has its **edge** at 21, not its centre at 30. An earlier draft
   * verified centre distance only, found 24 "safe", and shipped slabs whose near
   * edges sat at 11.4m — inside the reach, i.e. jumpable-onto and see-through.
   *
   * The widest shape therefore sets the limit. With `SHAPES.slab` at 18 and the
   * jitter applied on top, the widest possible instance is 20.9 across, half of
   * that 10.4 — so even if the widest instance landed at the nearest lateral the
   * edge would be at 19.6m, still 5m clear of the floor. In the placement that
   * actually generates, the nearest edge is 22.4m.
   *
   * `nearX` is 30 with that in mind. The 8.3m reach assumes a flat sprint off the
   * pad edge at full speed with no air-control penalty, which is the optimistic
   * case, and the margin exists to absorb being wrong about it.
   *
   * **Verify the edge, not the centre, before changing any of this.** A player
   * who lands on an invisible floor and sinks through it is the worst bug this
   * feature could ship.
   */
  nearX: 30,

  /** Farthest lateral distance of any platform centre, world units. */
  farX: 66,

  /** How far the platforms stretch along the lane's axis, world units. */
  span: 380,

  /**
   * Tier heights above the pads, world units.
   *
   * All above the reach ceiling of ~1.6m even if the lateral distance were
   * wrong, so height is a second line of defence rather than the only one. The
   * lowest tier at 3m is already twice a standing jump — and note that the
   * shortest shape in `SHAPES` is 1.2 units thick, so the lowest *bottom* edge of
   * any platform is still 3m up.
   *
   * Gaps of 6m and 8m rather than even spacing: even tiers read as a stack of
   * shelves, uneven tiers read as built structures.
   */
  tiers: [
    { y: 3, color: RAMP.lightBlue, tag: 'low' },
    { y: 9, color: RAMP.lightPink, tag: 'mid' },
    { y: 17, color: RAMP.lavender, tag: 'high' },
  ],

  /**
   * Scale jitter per platform, as a fraction of the shape's authored size.
   *
   * Just enough that no two instances of the same shape are the same object.
   * Larger than this and the shapes stop being recognisable, which defeats the
   * point of having five distinct silhouettes.
   */
  jitter: 0.16,

  /**
   * Per-platform rotation, in radians, applied about Y.
   *
   * Rects and discs look wrong axis-aligned to the lane — a plate square to the
   * track reads as a game asset, and a rotated one reads as architecture. Facets
   * and cubes are left unrotated because their silhouettes are already
   * asymmetric enough to not need it.
   */
  yaw: 0.5,
} as const;
