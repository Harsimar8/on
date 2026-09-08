import * as Cesium from "cesium";

export interface Zone3DConfig {
    name: string;
    maxRange: number;       // The zone's FULL potential range in meters, in a
                             // direction with nothing blocking it.
    ceilingHeight: number;  // Thickness of this zone's coverage band, in
                             // meters, ABOVE wherever the ray actually ends
                             // (the ground, or a blocking mountain).
    color: Cesium.Color;
    wallAlpha: number;
    capAlpha: number;
}

export interface Radar3DOptions {
    longitude: number;
    latitude: number;
    antennaMastHeight?: number; // Height of antenna above ground (e.g. 25m)
    numAzimuths?: number;       // BASE number of azimuth rays before adaptive
                                 // refinement (144 = every 2.5 degrees).
                                 // Extra rays get inserted automatically
                                 // wherever neighbors disagree sharply.
    zones?: Zone3DConfig[];
}

export class Cesium3DRadarCoverage {
    public static readonly DEFAULT_3D_ZONES: Zone3DConfig[] = [
        {
            name: "Low-Altitude (Green)",
            maxRange: 5000,
            ceilingHeight: 400,
            color: Cesium.Color.fromCssColorString("#10B981"),
            wallAlpha: 0.35,
            capAlpha: 0.25
        },
        {
            name: "Mid-Altitude (Yellow)",
            maxRange: 16000,
            ceilingHeight: 900,
            color: Cesium.Color.fromCssColorString("#F59E0B"),
            wallAlpha: 0.30,
            capAlpha: 0.20
        },
        {
            name: "High-Altitude (Red/Pink)",
            maxRange: 20000,
            ceilingHeight: 1600,
            color: Cesium.Color.fromCssColorString("#EF4444"),
            wallAlpha: 0.25,
            capAlpha: 0.15
        }
    ];

    private static readonly MIN_BLOCK_SLOPE = 0.03;
    private static readonly MIN_BLOCK_DISTANCE = 300;
    private static readonly SMOOTH_WINDOW = 3;

    // --- Adaptive refinement settings ---

    // If two neighboring rays' "how far did it get" distances differ by more
    // than this, we suspect a mountain edge/gap sits between them that
    // neither ray directly sampled, and we insert a ray exactly in between
    // to check.
    private static readonly JUMP_DISTANCE_THRESHOLD_M = 800;

    // Stop subdividing a gap once the two rays are closer together than this
    // angle (~0.05 degrees) - prevents infinite bisection on a genuinely
    // vertical cliff edge.
    private static readonly MIN_ANGULAR_GAP_RAD = Cesium.Math.toRadians(0.05);

    // How many rounds of "insert a ray in the middle of every big gap" to
    // run. Each round can double the ray count in the affected areas.
    private static readonly MAX_REFINE_ROUNDS = 5;

    // Hard safety cap on total rays, so pathological terrain (e.g. cliffs
    // everywhere) can't blow up ray count / performance.
    private static readonly MAX_TOTAL_RAYS = 1600;

    private static readonly stepMeters = 250;

    /**
     * Builds terrain-aware volumetric radar coverage zones.
     *
     * Starts from `numAzimuths` evenly-spaced rays. Wherever two neighboring
     * rays disagree sharply about how far they can see (one gets blocked
     * close in, the next reaches full range) - a sign a mountain edge sits
     * between them - extra rays are automatically sampled in that gap until
     * the disagreement shrinks or a safety limit is hit. The final wall/cap
     * are built from this adaptively-spaced ray set, so edges hug mountain
     * shoulders instead of jumping straight across unsampled gaps.
     */
    static async create3DRadarZones(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: Radar3DOptions
    ): Promise<Cesium.Entity[]> {
        const {
            longitude,
            latitude,
            antennaMastHeight = 25,
            numAzimuths = 144,
            zones = this.DEFAULT_3D_ZONES
        } = options;

        const maxOverallRange = Math.max(...zones.map(z => z.maxRange));
        const stepsPerRay = Math.ceil(maxOverallRange / this.stepMeters);

        // 0. Sample the radar's own location first, so we know its eye
        // height before evaluating any ray.
        const radarCarto = Cesium.Cartographic.fromDegrees(longitude, latitude);
        try {
            await Cesium.sampleTerrain(terrainProvider, 11, [radarCarto]);
        } catch {
            const h = viewer.scene.globe.getHeight(radarCarto);
            if (h !== undefined) radarCarto.height = h;
        }
        const groundAltitude = radarCarto.height || 0;
        const radarOriginAlt = groundAltitude + antennaMastHeight;

        interface RayEntry {
            azimuthRad: number;
            blockDist: number | null;
            blockHeight: number | null;
            terrainForRay: number[]; // raw terrain height per 250m step, up to maxOverallRange
        }

        // Samples a BATCH of rays (given their azimuths) in one terrain call,
        // and computes each one's blocking result. Used both for the initial
        // base rays and for every later round of inserted rays.
        const computeRayEntries = async (azimuthRads: number[]): Promise<RayEntry[]> => {
            const cartographics: Cesium.Cartographic[] = [];
            for (const azimuthRad of azimuthRads) {
                for (let s = 1; s <= stepsPerRay; s++) {
                    const dist = Math.min(s * this.stepMeters, maxOverallRange);
                    const { lon, lat } = this.destinationCoordinate(longitude, latitude, dist, azimuthRad);
                    cartographics.push(Cesium.Cartographic.fromDegrees(lon, lat));
                }
            }

            try {
                await Cesium.sampleTerrain(terrainProvider, 11, cartographics);
            } catch {
                try {
                    await Cesium.sampleTerrain(terrainProvider, 9, cartographics);
                } catch {
                    for (const c of cartographics) {
                        const h = viewer.scene.globe.getHeight(c);
                        if (h !== undefined) c.height = h;
                    }
                }
            }

            const entries: RayEntry[] = [];

            for (let a = 0; a < azimuthRads.length; a++) {
                const rayStart = a * stepsPerRay;
                const rawTerrainForRay: number[] = [];
                for (let s = 0; s < stepsPerRay; s++) {
                    rawTerrainForRay.push(cartographics[rayStart + s]?.height ?? groundAltitude);
                }

                const smoothedTerrainForRay: number[] = rawTerrainForRay.map((_, i) => {
                    const lo = Math.max(0, i - Math.floor(this.SMOOTH_WINDOW / 2));
                    const hi = Math.min(rawTerrainForRay.length - 1, i + Math.floor(this.SMOOTH_WINDOW / 2));
                    let sum = 0;
                    for (let k = lo; k <= hi; k++) sum += rawTerrainForRay[k];
                    return sum / (hi - lo + 1);
                });

                let runningMaxSlope = -Infinity;
                let blockDist: number | null = null;
                let blockHeight: number | null = null;

                for (let s = 1; s <= stepsPerRay; s++) {
                    const dist = s * this.stepMeters;
                    const terrainH = smoothedTerrainForRay[s - 1];
                    const earthDrop = (dist * dist) / (2 * 6378137);
                    const slope = (terrainH + earthDrop - radarOriginAlt) / dist;

                    if (slope > runningMaxSlope) {
                        runningMaxSlope = slope;
                        if (slope > this.MIN_BLOCK_SLOPE && dist > this.MIN_BLOCK_DISTANCE) {
                            blockDist = dist;
                            blockHeight = rawTerrainForRay[s - 1];
                        }
                    }
                }

                entries.push({
                    azimuthRad: azimuthRads[a],
                    blockDist,
                    blockHeight,
                    terrainForRay: rawTerrainForRay
                });
            }

            return entries;
        };

        // "Effective distance" used purely to detect big jumps between
        // neighbors: a clear ray (null) is treated as reaching maxOverallRange.
        const effDist = (r: RayEntry) => r.blockDist ?? maxOverallRange;

        // 1. Base rays, evenly spaced.
        const baseAzimuths = Array.from({ length: numAzimuths }, (_, a) => (a / numAzimuths) * Cesium.Math.TWO_PI);
        let rays: RayEntry[] = await computeRayEntries(baseAzimuths);
        rays.sort((a, b) => a.azimuthRad - b.azimuthRad);

        // 2. Adaptive refinement rounds: find big neighbor-to-neighbor jumps
        // (checking the circular wrap-around pair too), insert a midpoint
        // ray for each, batch-sample them all at once, splice them in.
        for (let round = 0; round < this.MAX_REFINE_ROUNDS; round++) {
            if (rays.length >= this.MAX_TOTAL_RAYS) break;

            const midpointAzimuths: number[] = [];
            const insertAfterIndex: number[] = [];

            for (let i = 0; i < rays.length; i++) {
                const cur = rays[i];
                const next = rays[(i + 1) % rays.length];

                let angularGap = next.azimuthRad - cur.azimuthRad;
                if (angularGap <= 0) angularGap += Cesium.Math.TWO_PI;

                if (angularGap <= this.MIN_ANGULAR_GAP_RAD) continue;

                const distJump = Math.abs(effDist(cur) - effDist(next));
                if (distJump > this.JUMP_DISTANCE_THRESHOLD_M) {
                    const midAz = (cur.azimuthRad + angularGap / 2) % Cesium.Math.TWO_PI;
                    midpointAzimuths.push(midAz);
                    insertAfterIndex.push(i);
                }
            }

            if (midpointAzimuths.length === 0) break;

            const room = this.MAX_TOTAL_RAYS - rays.length;
            if (room <= 0) break;
            const azimuthsToSample = midpointAzimuths.slice(0, room);
            const indicesToUse = insertAfterIndex.slice(0, room);

            const newEntries = await computeRayEntries(azimuthsToSample);

            const combined = indicesToUse.map((idx, k) => ({ idx, entry: newEntries[k] }));
            combined.sort((a, b) => b.idx - a.idx);
            for (const { idx, entry } of combined) {
                rays.splice(idx + 1, 0, entry);
            }
        }

        // 3. Build each zone from the final adaptive ray set.
        const createdEntities: Cesium.Entity[] = [];

        const getRawTerrainAtDist = (r: RayEntry, targetDist: number): number => {
            const idx = Math.min(Math.max(1, Math.round(targetDist / this.stepMeters)), stepsPerRay) - 1;
            return r.terrainForRay[idx] ?? groundAltitude;
        };

        for (let zIdx = zones.length - 1; zIdx >= 0; zIdx--) {
            const zone = zones[zIdx];

            const wallTop: Cesium.Cartesian3[] = [];
            const wallBottomHeights: number[] = [];
            const capPositions: Cesium.Cartesian3[] = [];

            for (const ray of rays) {
                let endpointDist: number;
                let floor: number;

                if (ray.blockDist !== null && ray.blockDist < zone.maxRange) {
                    endpointDist = ray.blockDist;
                    floor = ray.blockHeight as number;
                } else {
                    endpointDist = zone.maxRange;
                    floor = getRawTerrainAtDist(ray, zone.maxRange);
                }

                const roof = floor + zone.ceilingHeight;
                const { lon, lat } = this.destinationCoordinate(longitude, latitude, endpointDist, ray.azimuthRad);
                const topPos = Cesium.Cartesian3.fromDegrees(lon, lat, roof);

                wallTop.push(topPos);
                wallBottomHeights.push(floor);
                capPositions.push(topPos);
            }

            wallTop.push(wallTop[0]);
            wallBottomHeights.push(wallBottomHeights[0]);

            const wallEntity = viewer.entities.add({
                name: `${zone.name} 3D Wall`,
                wall: {
                    positions: wallTop,
                    minimumHeights: wallBottomHeights,
                    material: zone.color.withAlpha(zone.wallAlpha),
                    outline: true,
                    outlineColor: zone.color.withAlpha(0.9),
                    outlineWidth: 2
                }
            });
            createdEntities.push(wallEntity);

            const capEntity = viewer.entities.add({
                name: `${zone.name} Top Cap`,
                polygon: {
                    hierarchy: new Cesium.PolygonHierarchy(capPositions),
                    perPositionHeight: true,
                    material: zone.color.withAlpha(zone.capAlpha),
                    outline: true,
                    outlineColor: zone.color.withAlpha(0.85)
                }
            });
            createdEntities.push(capEntity);
        }

        return createdEntities;
    }

    private static destinationCoordinate(
        lonDeg: number,
        latDeg: number,
        distMeters: number,
        bearingRad: number
    ): { lon: number; lat: number } {
        const R = 6378137.0;
        const dByR = distMeters / R;
        const lat1 = Cesium.Math.toRadians(latDeg);
        const lon1 = Cesium.Math.toRadians(lonDeg);

        const lat2 = Math.asin(
            Math.sin(lat1) * Math.cos(dByR) +
            Math.cos(lat1) * Math.sin(dByR) * Math.cos(bearingRad)
        );

        const lon2 = lon1 + Math.atan2(
            Math.sin(bearingRad) * Math.sin(dByR) * Math.cos(lat1),
            Math.cos(dByR) - Math.sin(lat1) * Math.sin(lat2)
        );

        return {
            lon: Cesium.Math.toDegrees(lon2),
            lat: Cesium.Math.toDegrees(lat2)
        };
    }
}