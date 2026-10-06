/**
 * Scene visuals
 *
 * Meshes are followers, never authorities. Every frame they copy whatever the
 * simulation reports — nothing here writes back into the sim.
 *
 * Lighting and the local racer only. Course geometry comes from
 * course/build.ts and other racers from net/remotes.ts, so this file does not
 * change when either of those does.
 */

import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  color,
  dot,
  mix,
  mul,
  normalize,
  normalWorld,
  oneMinus,
  pow,
  positionWorld,
  saturate,
  sub,
  uniform,
} from 'three/tsl';

import type { Stage } from '../core/stage.ts';
import { CAMERA, PLAYER } from '../constants.ts';
import { NEON, PALETTE, POST, RAMP } from './palette.ts';
import type { Pose } from '../physics/player.ts';

/**
 * Where the local racer is and what it is doing.
 *
 * Passed in rather than read from a body, because the position comes from the
 * *predicted* simulation and can differ from anything the server has
 * confirmed. The render layer has no business knowing where that came from.
 */
export interface LocalPose extends Pose {
  grounded: boolean;
}

export interface SceneVisuals {
  /**
   * Copy the predicted state into meshes. Call once per rendered frame.
   *
   * `dt` is the real frame delta in seconds. It is required, not optional:
   * cosmetic smoothing that takes a frame delta must be told what it was, or it
   * falls back to assuming a fixed refresh rate.
   */
  sync(pose: LocalPose, dt: number): void;

  /**
   * Point the camera at a yaw/pitch, in radians.
   *
   * Yaw 0 looks down -Z, which is the course's start direction, so the default
   * frame matches the world-Z-locked view this replaced. Purely client-side:
   * nothing here is sent to the server.
   */
  orbit(yaw: number, pitch: number): void;

  dispose(): void;
}

const clampNumber = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value;

/**
 * Camera offset from the focus point for a given yaw and pitch.
 *
 * Yaw 0 places the camera on +Z, looking toward -Z. Pitch rotates the offset up
 * from there. Out-parameter rather than a returned Vector3 to keep this free of
 * per-frame allocation.
 */
function orbitOffset(out: THREE.Vector3, yaw: number, pitch: number): THREE.Vector3 {
  const horizontal = Math.cos(pitch) * CAMERA.distance;
  return out.set(
    Math.sin(yaw) * horizontal,
    Math.sin(pitch) * CAMERA.distance,
    Math.cos(yaw) * horizontal,
  );
}

export function buildScene(stage: Stage): SceneVisuals {
  const { scene } = stage;

  // --- lighting ------------------------------------------------------------
  // Built for a near-black scene. There is no sun and no sky, so every light
  // here is a shaping tool rather than an illumination source: one dim key so
  // the top faces of the architecture read as form, and two coloured rims from
  // behind to separate silhouettes from the fog.
  //
  // The previous build had a 2.4-intensity warm sun and a 2.2 hemisphere,
  // because it was rendering under a blue sky. Those numbers would blow out
  // completely here — hence the large drop.
  //
  // The hemisphere's ground colour is `PALETTE.base` rather than a dark grey on
  // purpose. Against a background of `#020202` a hemisphere that lights the
  // undersides with anything lighter reads as a grey fog sitting on the ground
  // plane, and the pads stop looking like they are above anything.
  const hemi = new THREE.HemisphereLight(NEON.violet, PALETTE.base, 0.5);
  scene.add(hemi);

  // Palette white rather than the previous hand-picked lavender `0xd8d4ff`. The
  // ramp's white is a cool `#F4FAFC`, which is close enough that the look is
  // unchanged, and it means the key light is a palette entry rather than a magic
  // number that nothing else can see.
  const key = new THREE.DirectionalLight(RAMP.white, 1.6);
  key.position.set(30, 50, 20);
  scene.add(key);

  const rimCyan = new THREE.DirectionalLight(NEON.cyan, 1.1);
  rimCyan.position.set(-40, 18, -35);
  scene.add(rimCyan);

  const rimMagenta = new THREE.DirectionalLight(NEON.magenta, 0.8);
  rimMagenta.position.set(38, 14, -40);
  scene.add(rimMagenta);

  // --- local racer ---------------------------------------------------------
  // The capsule is a dark body carrying an iridescent emissive shell rather than
  // a coloured solid.
  //
  // A solid bright capsule reads as a game character. What sells "premium" here
  // is the opposite: an almost-black body whose light comes entirely from a
  // view-dependent rim, so the racer looks like a piece of lit glass. It also
  // means the bloom pass has something to work with — emissive values above 1
  // are what the bloom threshold is tuned to catch.
  const glowTint = uniform(new THREE.Color(NEON.violet));

  const playerMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(PLAYER.radius, PLAYER.halfHeight * 2, 8, 16),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE.mass),
      roughness: 0.35,
      metalness: 0.1,
    }),
  );

  // Fresnel term: 0 facing the camera, 1 at grazing angles. This is what makes
  // the highlight hug the silhouette instead of sitting on the middle of the
  // body facing the viewer. The exponent tightens it, so the rim stays a rim
  // rather than washing over half the capsule.
  const viewDir = normalize(sub(cameraPosition, positionWorld));
  const fresnel = pow(oneMinus(saturate(dot(normalize(normalWorld), viewDir))), 2.6);

  // Three-stop ramp: magenta where the body faces you, through the tint, to cyan
  // at the silhouette. Two chained mixes rather than one, because a two-colour
  // lerp gives a straight line through the ramp and reads as a colour wash
  // instead of as an oil-slick shift.
  const hueLow = mix(color(NEON.magenta), glowTint, clamp(mul(fresnel, 2), 0, 1));
  const hue = mix(hueLow, color(NEON.cyan), clamp(mul(sub(fresnel, 0.5), 2), 0, 1));

  // Amplitude above 1 on purpose: the bloom threshold is a luminance cutoff, so
  // an emissive clamped to 1 would barely register as bright. `POST.emissiveGain`
  // carries the per-platform budget — see the note on Scheme.
  (playerMesh.material as THREE.MeshStandardMaterial).emissiveNode = mul(
    hue,
    mul(fresnel, POST.emissiveGain),
  );

  scene.add(playerMesh);

  // A flat ring under the capsule reads as a contact cue, which makes grounded
  // vs airborne obvious without a shadow map. Neon rather than a dark shadow:
  // there is no lit ground here for a shadow to darken.
  const markerMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(NEON.cyan),
    transparent: true,
    opacity: 0.7,
    toneMapped: false,
  });
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.62, 32),
    markerMaterial,
  );
  marker.rotation.x = -Math.PI / 2;
  scene.add(marker);

  const tint = new THREE.Color();
  const groundedTint = new THREE.Color(NEON.violet);
  const airborneTint = new THREE.Color(NEON.amber);
  const groundedMarker = new THREE.Color(NEON.cyan);
  const airborneMarker = new THREE.Color(NEON.amber);

  const followTarget = new THREE.Vector3();
  const followPoint = new THREE.Vector3();
  const cameraOffset = new THREE.Vector3();

  let yaw = 0;
  // Annotated because CAMERA is `as const`; without it this narrows to the
  // literal 0.5 and `orbit()` cannot assign to it.
  let pitch: number = CAMERA.pitch;
  let snapping = true;

  return {
    sync(pose, dt) {
      playerMesh.position.set(pose.x, pose.y, pose.z);

      // The ring stays at ground level rather than following the capsule, so it
      // doubles as a height cue while airborne.
      // Just above the deck surface. Hardcoded rather than derived from
      // `ATMOS.gridY`: the pads' top faces are at y=0 and the grid sits below
      // them, so tracking the grid would bury this ring inside the geometry.
      marker.position.set(pose.x, 0.02, pose.z);

      // The airborne tint moved from the mesh's base colour to the emissive
      // tint, because the base colour is now almost black and tinting it does
      // nothing visible. The hue is the same amber it always was, so the cue
      // keeps meaning the same thing.
      tint.copy(pose.grounded ? groundedTint : airborneTint);
      glowTint.value.lerp(tint, 0.25);
      markerMaterial.color.lerp(pose.grounded ? groundedMarker : airborneMarker, 0.25);

      // --- follow camera ---------------------------------------------------
      // Position is offset from the racer by a fixed spherical rig (see
      // `orbitOffset`), so it only ever has to chase the racer's motion.
      //
      // The smoothing factor is built from the REAL frame delta. The previous
      // version passed FIXED_TIMESTEP here, which silently assumed 60fps: at
      // 144Hz it applied 2.5x the intended stiffness, pinning the camera to the
      // raw predicted pose and exposing every reconciliation rollback as a
      // visible twitch. The racer's predicted position is corrected ~20x/sec,
      // so an under-filtered camera reads as jitter rather than lag.
      const k = 1 - Math.exp(-CAMERA.smoothing * dt);

      followTarget.set(pose.x, pose.y + CAMERA.lookAtHeight, pose.z);
      // Snap on the first frame, otherwise the camera flies in from wherever
      // core/stage.ts seeded it.
      if (snapping) {
        followPoint.copy(followTarget);
        snapping = false;
      } else {
        followPoint.lerp(followTarget, k);
      }

      orbitOffset(cameraOffset, yaw, pitch);
      stage.camera.position.copy(followPoint).add(cameraOffset);
      stage.camera.lookAt(followPoint);
    },

    orbit(y, p) {
      yaw = y;
      pitch = clampNumber(p, CAMERA.minPitch, CAMERA.maxPitch);
    },

    dispose() {
      scene.remove(playerMesh, marker, hemi, key, rimCyan, rimMagenta);
      playerMesh.geometry.dispose();
      (playerMesh.material as THREE.Material).dispose();
      marker.geometry.dispose();
      markerMaterial.dispose();
    },
  };
}