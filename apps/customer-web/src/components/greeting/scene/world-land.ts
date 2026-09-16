/**
 * The world, as coordinates this repository owns.
 *
 * The globe needs recognisable continents, and there are three ways to get
 * them. Two of them are wrong here:
 *
 *   - **Fetching a NASA or Natural Earth bitmap at runtime.** A landing page
 *     that reaches for a third-party image before it can finish drawing itself
 *     is a landing page with somebody else's uptime, somebody else's CORS
 *     policy and somebody else's privacy footprint in it. UBOSS is self-hosted;
 *     a buyer running it on an air-gapped network would get a blue marble with
 *     no marble on it.
 *   - **Shipping a downloaded texture in `public/`.** Better, but it is most of
 *     a megabyte of PNG for an object that is 180 pixels across, and it carries
 *     a licence somebody has to keep track of for the life of the product.
 *
 * So the coastlines are *data*, written here as degrees and rasterised into a
 * canvas at the size the scene actually wants. About 6 KB of numbers, no
 * request, no licence, no 404 — and it is legible enough to edit: if a buyer in
 * a market we have not thought about wants their own island drawn in, that is a
 * few more pairs of numbers rather than an image pipeline.
 *
 * **These are deliberately coarse.** The globe is ~180 CSS pixels across on a
 * desktop, which is about half a pixel per degree of longitude at the equator.
 * Outlines accurate to a tenth of a degree would cost bytes to draw sub-pixel
 * detail nobody can see. What matters at this size is the *silhouette* — that
 * Africa reads as Africa and India reads as India — and that is what these
 * have. They are a visual, not a map: nothing in the product measures anything
 * against them, and no shipping, tax or market decision reads this file.
 *
 * Coordinates are `[longitude, latitude]` in degrees, longitude east-positive
 * from -180 to 180 and latitude north-positive from -90 to 90 — the order
 * GeoJSON uses, so a ring lifted from a real dataset drops in unchanged.
 *
 * **No ring may cross the antimeridian.** The projection below is a straight
 * linear map from longitude to x, so a polygon running from 179 to -179 would
 * be drawn as a band straight back across the entire world. Siberia is clipped
 * at 179 for exactly this reason and loses the tip of Chukotka, which at this
 * size is under a pixel.
 */

/** A `[longitude, latitude]` pair in degrees. */
export type LonLat = readonly [number, number];

/** A closed ring of coordinates. The first point is repeated at the end. */
export type Ring = readonly LonLat[];

/* -------------------------------------------------------------------------
 * Landmasses
 * ---------------------------------------------------------------------- */

const AFRICA: Ring = [
  [-17.5, 14.7], [-16.0, 19.5], [-13.0, 27.7], [-9.8, 30.0], [-5.5, 35.8],
  [0.0, 36.0], [10.2, 37.3], [11.5, 33.0], [19.0, 30.3], [25.0, 31.5],
  [32.5, 31.2], [34.5, 28.0], [35.5, 23.0], [37.5, 18.5], [39.0, 15.0],
  [43.3, 12.6], [47.0, 11.5], [51.4, 11.8], [51.0, 8.0], [47.0, 4.0],
  [43.0, -0.5], [40.5, -4.5], [40.0, -10.5], [40.5, -16.0], [35.5, -20.0],
  [33.0, -26.0], [31.0, -29.5], [27.5, -33.5], [22.0, -34.0], [18.4, -34.4],
  [16.0, -28.5], [14.5, -22.5], [11.8, -18.0], [13.5, -12.5], [12.0, -6.0],
  [9.5, -1.0], [9.8, 4.0], [5.5, 5.5], [1.0, 6.0], [-3.0, 5.0],
  [-7.5, 4.4], [-13.0, 8.5], [-16.5, 12.0], [-17.5, 14.7],
];

const EUROPE: Ring = [
  [-9.5, 38.7], [-9.0, 43.0], [-4.0, 43.5], [-1.5, 43.4], [-1.0, 46.0],
  [-4.8, 48.4], [-1.5, 49.8], [3.0, 51.5], [4.5, 53.0], [8.5, 54.0],
  [8.2, 57.0], [10.6, 57.7], [11.0, 59.0], [5.5, 59.0], [5.0, 62.0],
  [11.0, 64.0], [16.0, 68.5], [24.0, 70.5], [31.0, 70.0], [38.0, 66.0],
  [44.0, 68.0], [50.0, 69.0], [60.0, 70.0], [60.0, 60.0], [55.0, 52.0],
  [50.0, 46.5], [47.5, 44.0], [39.5, 43.5], [37.0, 44.5], [34.0, 45.3],
  [30.5, 46.5], [28.8, 44.0], [28.0, 41.0], [24.0, 40.5], [23.0, 37.5],
  [21.0, 37.0], [19.3, 40.0], [18.5, 42.5], [13.5, 45.5], [12.4, 44.5],
  [15.5, 41.9], [18.4, 40.0], [15.6, 37.9], [14.0, 40.8], [11.0, 42.4],
  [10.3, 43.9], [8.8, 44.4], [3.0, 43.0], [0.0, 40.0], [-0.5, 37.5],
  [-5.5, 36.0], [-7.0, 37.2], [-9.5, 38.7],
];

const ASIA: Ring = [
  [26.5, 40.0], [30.0, 36.5], [36.0, 36.5], [35.0, 33.0], [34.3, 31.3],
  [34.5, 28.0], [38.0, 24.0], [42.5, 16.0], [45.0, 12.8], [52.5, 16.5],
  [57.0, 22.5], [56.5, 25.5], [51.5, 24.5], [48.5, 29.5], [50.0, 30.0],
  [56.0, 27.0], [61.5, 25.0], [66.5, 25.0], [70.0, 21.0], [72.8, 19.0],
  [74.0, 15.0], [76.5, 8.3], [80.3, 13.1], [87.0, 21.5], [92.0, 21.0],
  [94.5, 16.0], [98.5, 8.5], [103.8, 1.3], [105.0, 10.0], [109.0, 13.0],
  [108.0, 21.0], [113.0, 22.3], [120.0, 25.0], [122.0, 31.0], [120.0, 37.5],
  [122.0, 39.5], [126.0, 38.5], [126.5, 34.5], [129.5, 35.5], [128.0, 41.0],
  [131.0, 43.0], [135.0, 48.0], [141.0, 53.0], [142.5, 59.0], [155.0, 57.0],
  [162.0, 58.0], [160.0, 61.5], [170.0, 62.5], [179.0, 65.5], [179.0, 68.5],
  [170.0, 69.5], [160.0, 70.0], [150.0, 72.0], [140.0, 73.5], [130.0, 73.5],
  [128.0, 71.0], [120.0, 73.5], [112.0, 74.5], [105.0, 76.5], [100.0, 76.0],
  [92.0, 75.5], [86.0, 73.5], [78.0, 72.5], [73.0, 71.5], [69.0, 73.0],
  [66.0, 71.0], [60.0, 66.0], [60.0, 55.0], [55.0, 50.0], [52.0, 45.5],
  [51.0, 44.0], [48.0, 41.5], [44.0, 41.0], [40.0, 41.0], [35.0, 42.0],
  [29.0, 41.0], [26.5, 40.0],
];

const NORTH_AMERICA: Ring = [
  [-168.0, 65.7], [-165.0, 60.5], [-162.0, 58.0], [-158.0, 56.0], [-152.0, 58.5],
  [-148.0, 60.5], [-140.0, 59.5], [-135.0, 57.0], [-130.0, 52.5], [-125.0, 48.5],
  [-124.0, 43.0], [-122.0, 37.0], [-118.5, 34.0], [-117.1, 32.5], [-112.0, 25.5],
  [-106.0, 22.0], [-105.0, 20.5], [-95.5, 16.0], [-92.5, 14.5], [-87.5, 13.0],
  [-83.0, 9.5], [-79.0, 9.0], [-82.5, 9.5], [-83.5, 11.0], [-87.0, 15.9],
  [-88.5, 18.5], [-87.0, 21.5], [-90.5, 21.0], [-92.0, 18.7], [-95.0, 18.8],
  [-97.5, 22.5], [-97.2, 26.0], [-94.5, 29.5], [-89.0, 29.0], [-85.0, 30.0],
  [-82.5, 27.5], [-80.1, 25.2], [-81.0, 31.0], [-75.5, 35.2], [-74.0, 40.5],
  [-70.0, 42.0], [-67.0, 45.0], [-64.0, 46.0], [-60.0, 47.0], [-64.0, 53.0],
  [-60.0, 56.0], [-64.0, 60.0], [-70.0, 61.5], [-78.0, 62.5], [-86.0, 66.0],
  [-96.0, 67.5], [-105.0, 68.5], [-115.0, 69.5], [-125.0, 70.0], [-133.0, 69.5],
  [-141.0, 70.0], [-156.0, 71.3], [-163.0, 69.5], [-168.0, 65.7],
];

const SOUTH_AMERICA: Ring = [
  [-77.0, 8.0], [-77.5, 4.0], [-80.0, -2.0], [-81.0, -6.0], [-79.0, -8.0],
  [-76.5, -14.5], [-70.5, -18.5], [-70.5, -23.0], [-71.5, -30.0], [-73.0, -37.0],
  [-74.0, -42.5], [-75.0, -48.0], [-74.5, -52.0], [-69.5, -55.0], [-65.0, -54.5],
  [-68.0, -52.0], [-65.5, -47.0], [-62.5, -41.0], [-57.5, -38.5], [-56.5, -34.5],
  [-53.5, -33.0], [-48.5, -28.5], [-45.0, -24.0], [-40.5, -20.5], [-39.0, -16.0],
  [-37.0, -11.0], [-35.0, -5.5], [-41.0, -2.5], [-48.5, -1.0], [-50.5, 0.5],
  [-51.5, 4.0], [-57.0, 6.0], [-60.0, 8.5], [-62.0, 10.5], [-68.0, 11.5],
  [-71.5, 12.5], [-74.0, 11.0], [-76.5, 9.5], [-77.0, 8.0],
];

const AUSTRALIA: Ring = [
  [113.2, -22.0], [114.0, -26.5], [115.0, -31.5], [118.0, -35.0], [123.0, -34.0],
  [129.0, -31.7], [134.0, -32.5], [136.5, -35.0], [138.5, -35.0], [140.0, -38.0],
  [145.0, -38.8], [150.0, -37.5], [151.5, -33.0], [153.5, -28.5], [153.0, -25.5],
  [149.0, -21.0], [146.5, -19.0], [145.5, -15.0], [142.5, -10.7], [141.5, -13.0],
  [139.0, -17.5], [136.5, -12.0], [132.5, -11.0], [130.0, -12.5], [126.0, -14.0],
  [123.5, -16.5], [122.0, -18.0], [118.0, -20.3], [113.2, -22.0],
];

const GREENLAND: Ring = [
  [-45.0, 60.0], [-51.0, 64.0], [-53.5, 68.0], [-55.0, 71.0], [-58.0, 75.5],
  [-63.0, 78.0], [-68.0, 80.0], [-60.0, 82.0], [-45.0, 83.0], [-30.0, 83.5],
  [-20.0, 81.5], [-18.0, 76.0], [-22.0, 72.0], [-26.0, 68.5], [-38.0, 65.5],
  [-43.0, 60.5], [-45.0, 60.0],
];

/**
 * The bottom of the world, as a band rather than a shape.
 *
 * Equirectangular puts the south pole along an entire edge of the texture, so
 * Antarctica is drawn as a coast running the full width which then closes along
 * that edge. Sweeping west to east in one pass — never wrapping — is what keeps
 * it from crossing the antimeridian.
 */
const ANTARCTICA: Ring = [
  [-180.0, -78.0], [-160.0, -78.0], [-150.0, -75.0], [-130.0, -73.0],
  [-110.0, -73.0], [-90.0, -72.0], [-75.0, -72.0], [-60.0, -63.0],
  [-55.0, -63.0], [-45.0, -75.0], [-30.0, -77.0], [-10.0, -70.0],
  [10.0, -70.0], [30.0, -68.0], [50.0, -66.0], [70.0, -67.0], [90.0, -66.0],
  [110.0, -66.0], [130.0, -66.0], [150.0, -70.0], [165.0, -78.0],
  [180.0, -78.0], [180.0, -90.0], [-180.0, -90.0], [-180.0, -78.0],
];

/* Islands, roughly west to east. */

const ICELAND: Ring = [
  [-24.5, 65.5], [-22.0, 66.5], [-16.0, 66.5], [-14.0, 65.2], [-15.0, 64.0],
  [-21.0, 63.4], [-24.5, 65.5],
];

const IRELAND: Ring = [
  [-10.0, 51.5], [-10.2, 54.2], [-8.0, 55.3], [-5.5, 54.5], [-6.0, 52.2],
  [-9.5, 51.5], [-10.0, 51.5],
];

const BRITAIN: Ring = [
  [-5.0, 50.0], [-3.0, 51.5], [-4.5, 53.5], [-3.0, 54.5], [-5.0, 55.8],
  [-5.5, 58.5], [-3.0, 58.6], [-2.0, 57.0], [0.0, 53.5], [1.7, 52.5],
  [1.0, 51.3], [-5.0, 50.0],
];

const SICILY: Ring = [[12.4, 38.0], [15.1, 38.2], [15.3, 37.1], [12.4, 37.8], [12.4, 38.0]];

const SVALBARD: Ring = [
  [10.5, 76.6], [17.0, 76.6], [21.0, 78.5], [19.0, 80.0], [11.0, 79.5], [10.5, 76.6],
];

const NOVAYA_ZEMLYA: Ring = [
  [52.0, 70.8], [58.0, 73.0], [60.0, 76.0], [68.0, 76.5], [62.0, 72.0],
  [55.5, 70.5], [52.0, 70.8],
];

const MADAGASCAR: Ring = [
  [49.5, -12.5], [50.5, -15.5], [48.5, -20.0], [47.0, -25.0], [45.0, -25.5],
  [43.5, -22.0], [43.3, -17.0], [46.5, -15.5], [49.5, -12.5],
];

const SRI_LANKA: Ring = [
  [79.8, 9.5], [81.2, 8.5], [81.8, 6.5], [80.5, 5.9], [79.7, 7.5], [79.8, 9.5],
];

const SUMATRA: Ring = [
  [95.3, 5.6], [97.5, 4.0], [100.5, 0.5], [103.5, -2.0], [105.8, -5.9],
  [104.0, -5.9], [100.5, -3.0], [98.0, 1.5], [95.3, 5.6],
];

const JAVA: Ring = [
  [105.2, -6.0], [108.5, -6.2], [112.5, -6.9], [114.5, -8.2], [112.0, -8.4],
  [108.0, -7.7], [105.2, -6.9], [105.2, -6.0],
];

const BORNEO: Ring = [
  [109.0, 2.0], [112.0, 3.2], [117.5, 4.2], [119.0, 1.0], [117.0, -1.0],
  [116.0, -3.8], [112.0, -3.2], [110.0, -1.5], [109.0, 2.0],
];

const SULAWESI: Ring = [
  [119.5, 1.5], [125.0, 1.5], [125.5, -1.0], [122.0, -1.0], [121.5, -5.5],
  [119.5, -5.5], [119.0, -3.0], [119.5, 1.5],
];

const NEW_GUINEA: Ring = [
  [131.0, -1.0], [135.0, -2.0], [140.0, -2.5], [144.5, -4.5], [147.5, -6.0],
  [150.5, -10.5], [146.0, -8.0], [141.0, -8.5], [137.0, -8.0], [133.0, -4.5],
  [131.0, -1.0],
];

const LUZON: Ring = [
  [120.0, 18.5], [122.0, 17.0], [122.5, 14.0], [121.0, 13.5], [120.0, 15.5], [120.0, 18.5],
];

const MINDANAO: Ring = [
  [122.0, 7.0], [126.0, 7.5], [126.5, 9.5], [124.0, 9.0], [122.0, 7.0],
];

const TAIWAN: Ring = [[120.0, 25.3], [121.9, 25.0], [121.0, 22.0], [120.1, 22.5], [120.0, 25.3]];

const HONSHU: Ring = [
  [129.5, 33.0], [131.0, 31.5], [132.0, 33.5], [134.5, 34.0], [135.5, 33.5],
  [137.0, 34.6], [139.8, 34.7], [140.9, 35.7], [141.0, 38.3], [141.5, 41.5],
  [140.0, 41.5], [138.0, 37.0], [136.0, 37.4], [133.0, 35.5], [130.9, 34.4],
  [129.5, 33.0],
];

const HOKKAIDO: Ring = [
  [140.0, 42.0], [140.0, 45.5], [144.5, 44.3], [145.5, 43.3], [143.0, 42.0], [140.0, 42.0],
];

const TASMANIA: Ring = [
  [144.6, -40.7], [148.3, -40.8], [148.0, -43.0], [146.0, -43.6], [145.0, -42.0],
  [144.6, -40.7],
];

const NZ_NORTH: Ring = [
  [172.7, -34.4], [174.5, -36.0], [177.0, -38.0], [178.5, -37.6], [177.0, -39.5],
  [175.0, -41.5], [174.0, -41.5], [172.7, -34.4],
];

const NZ_SOUTH: Ring = [
  [172.0, -40.5], [174.3, -41.6], [172.5, -43.5], [170.0, -45.9], [167.0, -46.5],
  [166.5, -45.5], [171.0, -42.5], [172.0, -40.5],
];

const NEWFOUNDLAND: Ring = [
  [-59.3, 47.6], [-55.5, 46.7], [-52.7, 47.5], [-55.5, 51.5], [-57.5, 51.4], [-59.3, 47.6],
];

const CUBA: Ring = [
  [-84.9, 22.0], [-81.0, 23.2], [-77.0, 22.0], [-74.2, 20.3], [-77.5, 19.9],
  [-82.0, 21.5], [-84.9, 22.0],
];

const HISPANIOLA: Ring = [
  [-74.5, 18.4], [-71.0, 19.9], [-68.3, 19.0], [-68.5, 18.2], [-72.0, 18.0], [-74.5, 18.4],
];

/** Every landmass drawn, largest first so the big shapes settle the look. */
export const LAND: readonly Ring[] = [
  ANTARCTICA, ASIA, AFRICA, NORTH_AMERICA, SOUTH_AMERICA, EUROPE, AUSTRALIA,
  GREENLAND, NEW_GUINEA, BORNEO, MADAGASCAR, SUMATRA, HONSHU, SULAWESI,
  NOVAYA_ZEMLYA, BRITAIN, JAVA, NZ_SOUTH, NZ_NORTH, NEWFOUNDLAND, CUBA,
  ICELAND, HOKKAIDO, IRELAND, LUZON, MINDANAO, SVALBARD, HISPANIOLA,
  SRI_LANKA, TASMANIA, TAIWAN, SICILY,
];

/**
 * Water that the outlines above enclose, and which is punched back out.
 *
 * Only two are worth the bytes. Hudson Bay is the notch that makes North
 * America read as North America, and the Caspian is the one inland sea big
 * enough to see when Asia is drawn as a single ring from Turkey to Chukotka.
 * Everything smaller is below a pixel at the size this is rendered.
 */
export const SEAS: readonly Ring[] = [
  [
    [-78.0, 60.0], [-79.0, 56.5], [-82.0, 55.0], [-87.0, 53.5], [-92.0, 57.0],
    [-94.5, 59.5], [-92.0, 62.5], [-86.0, 64.0], [-80.0, 63.5], [-78.0, 60.0],
  ],
  [
    [47.0, 44.5], [51.5, 45.5], [53.5, 42.5], [52.0, 41.0], [53.5, 38.0],
    [50.0, 37.0], [48.5, 39.0], [49.5, 42.0], [47.0, 44.5],
  ],
];

/* -------------------------------------------------------------------------
 * Projection
 * ---------------------------------------------------------------------- */

/**
 * Longitude and latitude to pixels on an equirectangular canvas.
 *
 * This is the projection three.js's `SphereGeometry` expects of a texture: `u`
 * runs once round the equator and `v` from pole to pole, linearly in both. It
 * is the simplest possible mapping, and the reason for the antimeridian rule at
 * the top of this file — there is no wrapping anywhere in it.
 */
function project(lon: number, lat: number, width: number, height: number): [number, number] {
  return [((lon + 180) / 360) * width, ((90 - lat) / 180) * height];
}

/** Trace one ring onto a 2D context, in that context's own pixels. */
function trace(ctx: CanvasRenderingContext2D, ring: Ring, width: number, height: number): void {
  ctx.beginPath();

  ring.forEach((point, index) => {
    const [x, y] = project(point[0], point[1], width, height);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.closePath();
}

/** How the world should be painted. Colours are `rgb()` / `rgba()` strings. */
export interface WorldPaint {
  /** The body of each landmass. */
  fill: string;
  /** The coastline. Brighter than the fill: it is what gives the edge a lit look. */
  coast: string;
  /** Coastline thickness, in texture pixels at 1024 wide. */
  coastWidth: number;
}

/**
 * Paint the world onto a canvas, leaving the sea transparent.
 *
 * Transparent rather than blue, deliberately: this texture goes on a shell just
 * outside the glass sphere, so the sea has to be a hole through which the
 * sphere's own material — its metalness, its specular, the light travelling
 * across it — is what you see. A texture that painted its own ocean would
 * flatten the globe into a sticker of a globe.
 *
 * The seas are removed with `destination-out` rather than with an even-odd
 * fill, and that is not a stylistic choice. Several of the rings above overlap
 * one another (Europe and Asia share a long border and are drawn as two rings).
 * Under even-odd every overlap would cancel to a hole, and the Ural corridor
 * would come out as sea.
 */
export function paintWorld(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  paint: WorldPaint,
): void {
  ctx.clearRect(0, 0, width, height);

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.fillStyle = paint.fill;
  ctx.strokeStyle = paint.coast;
  ctx.lineWidth = (paint.coastWidth * width) / 1024;

  for (const ring of LAND) {
    trace(ctx, ring, width, height);
    ctx.fill();
    ctx.stroke();
  }

  ctx.globalCompositeOperation = 'destination-out';
  for (const ring of SEAS) {
    trace(ctx, ring, width, height);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/* -------------------------------------------------------------------------
 * Asking whether a point is on land
 * ---------------------------------------------------------------------- */

/**
 * A coarse land mask, and the one question the scene asks of it.
 *
 * The glowing network nodes belong on land rather than scattered over the whole
 * sphere — a node in the middle of the Pacific reads as a mistake, and the
 * arrangement that reads as *sourcing* is one where the lights sit where the
 * suppliers are.
 *
 * Answered by rasterising once and sampling the result, rather than by a
 * point-in-polygon test against thirty rings. The rasteriser is already
 * written, the browser's is in C, and one 256x128 pass is cheaper than a few
 * thousand ray casts in JavaScript.
 */
export interface LandMask {
  isLand: (lon: number, lat: number) => boolean;
}

/** The mask's resolution. Coarse on purpose; see `LandMask`. */
const MASK_WIDTH = 256;
const MASK_HEIGHT = 128;

/**
 * Build the mask, or one that says "no land" if a 2D context is unavailable.
 *
 * The fallback is not theoretical: jsdom has no 2D context, and a canvas in a
 * browser that has lost its context returns null too. A globe with no glowing
 * nodes is a slightly plainer globe; a globe that throws is no page at all.
 */
export function createLandMask(): LandMask {
  const canvas = document.createElement('canvas');
  canvas.width = MASK_WIDTH;
  canvas.height = MASK_HEIGHT;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) {
    return {
      isLand: () => {
        return false;
      },
    };
  }

  ctx.fillStyle = '#fff';

  for (const ring of LAND) {
    trace(ctx, ring, MASK_WIDTH, MASK_HEIGHT);
    ctx.fill();
  }

  const { data } = ctx.getImageData(0, 0, MASK_WIDTH, MASK_HEIGHT);

  return {
    isLand: (lon, lat) => {
      const [fx, fy] = project(lon, lat, MASK_WIDTH, MASK_HEIGHT);
      const x = Math.min(MASK_WIDTH - 1, Math.max(0, Math.floor(fx)));
      const y = Math.min(MASK_HEIGHT - 1, Math.max(0, Math.floor(fy)));

      // The alpha channel. The mask is drawn in opaque white on nothing, so
      // anything above zero is land.
      return (data[(y * MASK_WIDTH + x) * 4 + 3] ?? 0) > 0;
    },
  };
}

/**
 * Points spread evenly over the sphere, keeping only those that fall on land.
 *
 * A Fibonacci spiral rather than a latitude/longitude grid. A grid crowds its
 * points together at the poles, so the nodes would bunch into two bright caps
 * over Greenland and Antarctica and thin out across the equator — which is
 * exactly backwards for a graphic about trade.
 *
 * `samples` is how many candidates are tested, not how many come back: land is
 * under a third of the sphere, so expect roughly `samples / 3.5`.
 */
export function landPoints(samples: number, mask: LandMask): LonLat[] {
  // The golden angle, which is what makes the spiral fill evenly.
  const increment = Math.PI * (3 - Math.sqrt(5));
  const points: LonLat[] = [];

  for (let i = 0; i < samples; i += 1) {
    // Even in sin(latitude) rather than in latitude, so the points are spread
    // by equal AREA rather than by equal angle.
    const y = 1 - (i / Math.max(samples - 1, 1)) * 2;
    const lat = (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI;

    let lon = ((i * increment * 180) / Math.PI) % 360;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;

    // Antarctica is land, and a ring of nodes round the bottom of the globe
    // says nothing about sourcing. Everything below the Antarctic Circle is
    // dropped before the mask is even asked.
    if (lat < -60) continue;
    if (mask.isLand(lon, lat)) points.push([lon, lat]);
  }

  return points;
}

/**
 * A longitude and latitude as a point on a sphere of the given radius.
 *
 * The arrangement of signs is what lines geometry up with the texture:
 * three.js starts `SphereGeometry`'s `u` at the positive x-axis and runs it the
 * opposite way round from longitude, so a node placed by the naive formula
 * lands on the wrong side of the world from the coastline underneath it.
 */
export function lonLatToVector(
  lon: number,
  lat: number,
  radius: number,
): { x: number; y: number; z: number } {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;

  return {
    x: -radius * Math.sin(phi) * Math.cos(theta),
    y: radius * Math.cos(phi),
    z: radius * Math.sin(phi) * Math.sin(theta),
  };
}
