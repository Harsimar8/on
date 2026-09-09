
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

    // --- DEBUG VISUALIZATION ---
    // Draws every individual ray as a thin line from the radar out to
    // wherever it actually stopped (either the blocking mountain, or the
    // zone's full range). Turn this on to visually verify that rays are
    // stopping at the correct distance/mountain, and to see exactly where
    // the adaptive refinement inserted extra rays. Plain lines + dots only,
    // no text/labels.
    showDebugRays?: boolean;

    // Color of the RAY LINE itself (from radar to its endpoint). Off-white
    // by default so it reads clearly against both green terrain and the
    // colored coverage zones.
    debugRayLineColor?: Cesium.Color;
}

export class Cesium3DRadarCoverage {
    public static readonly DEFAULT_3D_ZONES: Zone3DConfig[] = [
        {
            name: "Low-Altitude (Green)",
            maxRange: 5000,
            ceilingHeight: 400,
            color: Cesium.Color.fromCssColorString("#7E22CE"),
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
            color: Cesium.Color.fromCssColorString("#0369A1"),
            wallAlpha: 0.25,
            capAlpha: 0.15
        }
    ];

    private static readonly MIN_BLOCK_SLOPE = 0.10;
    private static readonly MIN_BLOCK_DISTANCE = 600;
    private static readonly SMOOTH_WINDOW = 5;

    // Our terrain height comes from a ONE-TIME sample at LOD 11. Cesium
    // often RENDERS terrain at a higher resolution than that once you're
    // zoomed in, so the real visible ground can sit a little higher than
    // what we sampled. Without this margin, the wall's floor - sitting
    // exactly at our (slightly too low) sampled height - gets visually
    // swallowed by the terrain's depth test and looks like it's sinking
    // into the ground. Lifting the floor by a few meters keeps it visibly
    // sitting ON TOP of the real terrain instead.
    private static readonly FLOOR_SAFETY_MARGIN_M = 4;

    // --- Adaptive refinement settings ---

    private static readonly JUMP_DISTANCE_THRESHOLD_M = 250;
    private static readonly JUMP_HEIGHT_THRESHOLD_M = 120;
    private static readonly MIN_ANGULAR_GAP_RAD = Cesium.Math.toRadians(0.02);
    private static readonly MAX_REFINE_ROUNDS = 9;
    private static readonly MAX_TOTAL_RAYS = 6000;

    private static readonly stepMeters = 10;

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
     *
     * Set `showDebugRays: true` to draw every individual ray as a line so
     * you can visually confirm each one is stopping at the right place.
     */
    static async create3DRadarZones(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: Radar3DOptions
    ): Promise<Cesium.Entity[]> {
        const {
            longitude,
            latitude,
            antennaMastHeight = 0,
            numAzimuths = 144,
            zones = this.DEFAULT_3D_ZONES,
            showDebugRays = false,
            debugRayLineColor = Cesium.Color.fromCssColorString("#F5F1E8")
        } = options;

        const maxOverallRange = Math.max(...zones.map(z => z.maxRange));
        const stepsPerRay = Math.ceil(maxOverallRange / this.stepMeters);

        // 0. Determine the radar's own ground height. Prefer the LIVE,
        // currently-rendered globe height (viewer.scene.globe.getHeight) -
        // this is the SAME height source Cesium uses internally for
        // HeightReference.CLAMP_TO_GROUND billboards, so using it here
        // keeps the ray fan's origin point exactly where the radar marker
        // visually sits. A separate one-time sampleTerrain() query at a
        // fixed LOD can be tens of meters off on steep terrain and was
        // causing the whole ray fan to float away from the radar icon.
        // Fall back to sampleTerrain only if the live tile isn't loaded yet.
        const radarCarto = Cesium.Cartographic.fromDegrees(longitude, latitude);
        let groundAltitude = viewer.scene.globe.getHeight(radarCarto);
        if (groundAltitude === undefined) {
            try {
                await Cesium.sampleTerrain(terrainProvider, 11, [radarCarto]);
                groundAltitude = radarCarto.height ?? 0;
            } catch {
                groundAltitude = 0;
            }
        }
        const radarOriginAlt = groundAltitude + antennaMastHeight;

        interface RayEntry {
            azimuthRad: number;
            blockDist: number | null;
            blockHeight: number | null;
            terrainForRay: number[]; // raw terrain height per step, up to maxOverallRange
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

        const effDist = (r: RayEntry) => r.blockDist ?? maxOverallRange;

        const repHeight = (r: RayEntry): number => {
            if (r.blockDist !== null && r.blockHeight !== null) return r.blockHeight;
            const idx = Math.min(Math.max(1, Math.round(maxOverallRange / this.stepMeters)), stepsPerRay) - 1;
            return r.terrainForRay[idx] ?? groundAltitude;
        };

        // 1. Base rays, evenly spaced.
        const baseAzimuths = Array.from({ length: numAzimuths }, (_, a) => (a / numAzimuths) * Cesium.Math.TWO_PI);
        let rays: RayEntry[] = await computeRayEntries(baseAzimuths);
        rays.sort((a, b) => a.azimuthRad - b.azimuthRad);

        // 2. Adaptive refinement rounds.
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
                const heightJump = Math.abs(repHeight(cur) - repHeight(next));

                if (distJump > this.JUMP_DISTANCE_THRESHOLD_M || heightJump > this.JUMP_HEIGHT_THRESHOLD_M) {
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

        const createdEntities: Cesium.Entity[] = [];

        const getRawTerrainAtDist = (r: RayEntry, targetDist: number): number => {
            const idx = Math.min(Math.max(1, Math.round(targetDist / this.stepMeters)), stepsPerRay) - 1;
            return r.terrainForRay[idx] ?? groundAltitude;
        };

        // 3. DEBUG RAYS - draw every ray from the radar out to wherever it
        // actually stopped, so you can see with your own eyes which
        // direction reached full range vs which got cut short by terrain.
        if (showDebugRays) {
            const radarTop = Cesium.Cartesian3.fromDegrees(longitude, latitude, radarOriginAlt);

            for (const ray of rays) {
                const isBlocked = ray.blockDist !== null;
                const endDist = ray.blockDist ?? maxOverallRange;
                const endHeight = isBlocked
                    ? (ray.blockHeight as number)
                    : getRawTerrainAtDist(ray, maxOverallRange);

                const { lon, lat } = this.destinationCoordinate(longitude, latitude, endDist, ray.azimuthRad);
                // Lift the visible marker slightly above the ground so it
                // doesn't get hidden by the terrain depth test.
                const endPos = Cesium.Cartesian3.fromDegrees(lon, lat, endHeight + 15);

                const lineEntity = viewer.entities.add({
                    polyline: {
                        positions: [radarTop, endPos],
                        width: 3,
                        material: debugRayLineColor,
                        clampToGround: false,
                        // PolylineGraphics has no disableDepthTestDistance
                        // property (that only exists on Point/Billboard/
                        // Label). depthFailMaterial is the polyline
                        // equivalent: it's what gets drawn for the part of
                        // the line that's behind terrain, so the ray stays
                        // visible end-to-end instead of disappearing behind
                        // hills.
                        depthFailMaterial: debugRayLineColor
                    }
                });
                createdEntities.push(lineEntity);
            }
        }

        // 4. Build each zone from the final adaptive ray set.
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
                    floor = (ray.blockHeight as number) + this.FLOOR_SAFETY_MARGIN_M;
                } else {
                    endpointDist = zone.maxRange;
                    floor = getRawTerrainAtDist(ray, zone.maxRange) + this.FLOOR_SAFETY_MARGIN_M;
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