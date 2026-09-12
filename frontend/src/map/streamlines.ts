/**
 * Current direction as moving particles.
 *
 * Each particle follows the real u/v field, so the motion shows what the water
 * is doing. With prefers-reduced-motion the traces freeze instead of disappearing.
 *
 * The particle count is picked for readability (earth.nullschool and Copernicus
 * use around 3-6k); more just looks like noise.
 */

import type { MapTransform } from "./projection";

export interface VectorField {
  u: Float32Array;
  v: Float32Array;
  nLat: number;
  nLon: number;
  latRange: [number, number];
  lonRange: [number, number];
}

interface Particle {
  lon: number;
  lat: number;
  /** Frames lived. Particles are replaced at staggered times so the field doesn't pulse. */
  age: number;
  life: number;
}

const DEFAULT_COUNT = 4200;
const MIN_LIFE = 40;
const LIFE_SPREAD = 90;
/** Degrees moved per frame per m/s (~1 deg latitude = 111 km). */
const SPEED_SCALE = 0.055;

function sample(field: VectorField, lon: number, lat: number): [number, number] | null {
  const [lat0, lat1] = field.latRange;
  const [lon0, lon1] = field.lonRange;
  const fy = ((lat - lat0) / (lat1 - lat0)) * (field.nLat - 1);
  const fx = ((lon - lon0) / (lon1 - lon0)) * (field.nLon - 1);
  if (!(fy >= 0 && fy <= field.nLat - 1 && fx >= 0 && fx <= field.nLon - 1)) return null;
  const r = Math.round(fy);
  const c = Math.round(fx);
  const i = r * field.nLon + c;
  const u = field.u[i]!;
  const v = field.v[i]!;
  // NaN means land. Return null so the particle is replaced instead of getting a
  // NaN position.
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  return [u, v];
}

export class ParticleField {
  private particles: Particle[] = [];
  private field: VectorField | null = null;

  constructor(private count = DEFAULT_COUNT) {}

  setField(field: VectorField | null): void {
    this.field = field;
    this.particles = [];
    if (!field) return;
    for (let i = 0; i < this.count; i++) {
      this.particles.push(this.spawn());
    }
  }

  private spawn(): Particle {
    const f = this.field!;
    return {
      lon: f.lonRange[0] + Math.random() * (f.lonRange[1] - f.lonRange[0]),
      lat: f.latRange[0] + Math.random() * (f.latRange[1] - f.latRange[0]),
      age: Math.floor(Math.random() * LIFE_SPREAD),
      life: MIN_LIFE + Math.floor(Math.random() * LIFE_SPREAD),
    };
  }

  /**
   * Advance one frame and draw the trails. The previous frame is faded, not
   * cleared, which is what makes the trails. ``frozen`` skips the movement.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    transform: MapTransform,
    colour: string,
    frozen = false,
  ): void {
    const f = this.field;
    // CSS pixels from the transform, not ctx.canvas.width (see geography.ts).
    const { width, height } = transform.size;

    // Fade instead of clear so each particle leaves a tail.
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = `rgba(0, 0, 0, ${frozen ? 0 : 0.09})`;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "source-over";

    if (!f) return;

    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]!;
      const uv = sample(f, p.lon, p.lat);
      if (!uv || p.age > p.life) {
        this.particles[i] = this.spawn();
        continue;
      }
      const [u, v] = uv;

      // Longitude degrees get shorter toward the poles, so scale the east-west step.
      const cos = Math.max(0.2, Math.cos((p.lat * Math.PI) / 180));
      const nextLon = p.lon + (u * SPEED_SCALE) / cos;
      const nextLat = p.lat + v * SPEED_SCALE;

      const x0 = transform.lonToXNearest(p.lon);
      const y0 = transform.latToY(p.lat);
      const x1 = transform.lonToXNearest(nextLon);
      const y1 = transform.latToY(nextLat);

      // Skip segments that would cross the whole frame at the antimeridian.
      if (Math.abs(x1 - x0) < width / 4 && y0 > -50 && y0 < height + 50) {
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }

      if (!frozen) {
        p.lon = nextLon;
        p.lat = nextLat;
        p.age += 1;
      }
    }
    ctx.stroke();
  }
}
