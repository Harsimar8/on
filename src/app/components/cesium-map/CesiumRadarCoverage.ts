import * as Cesium from "cesium";

export interface Zone3DConfig {
    name: string;
    maxRange: number;       // Max range in meters
    ceilingHeight: number;  // Ceiling above radar ground in meters
    color: Cesium.Color;
    wallAlpha: number;
    capAlpha: number;
}

export interface Radar3DOptions {
    longitude: number;
    latitude: number;
    antennaMastHeight?: number; // Height of antenna above ground (e.g. 25m)
    numAzimuths?: number;       // Number of azimuth rays (72 = every 5 degrees)
    zones?: Zone3DConfig[];
}

export class Cesium3DRadarCoverage {
    public static readonly DEFAULT_3D_ZONES: Zone3DConfig[] = [
        {
            name: "Low-Altitude (Plum)",
            maxRange: 5000,
            ceilingHeight: 400, // 400m ceiling
            color: Cesium.Color.fromCssColorString("#7E22CE"),
            wallAlpha: 0.35,
            capAlpha: 0.25
        },
        {
            name: "Mid-Altitude (Amber)",
            maxRange: 16000, // widened from 12000 per request
            ceilingHeight: 900, // 900m ceiling
            color: Cesium.Color.fromCssColorString("#F59E0B"),
            wallAlpha: 0.30,
            capAlpha: 0.20
        },
        {
            name: "High-Altitude (Cobalt)",
            maxRange: 20000,
            ceilingHeight: 1600, // 1600m ceiling
            color: Cesium.Color.fromCssColorString("#0369A1"),
            wallAlpha: 0.25,
            capAlpha: 0.15
        }
    ];

    // Maximum allowed line-of-sight obstruction angle (radians).
    // tan(60 deg) ~= 1.73. Without this cap, one nearby ridge can force
    // the "shadow floor" to climb without bound at long range, which was
    // pushing wall tops above the ceiling and causing spikes on the horizon.
    private static readonly MAX_SLOPE = 1.73;

    /**
     * Builds true 3D volumetric radar cylinders with realistic 3D radar shadow.
     * Behind a mountain, the cylinder bottom FLOATS in the air and never touches the valley bed!
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
            numAzimuths = 144, // finer resolution -> smoother, less blocky circle
            zones = this.DEFAULT_3D_ZONES
        } = options;

        const maxOverallRange = Math.max(...zones.map(z => z.maxRange));
        const stepMeters = 250;
        const stepsPerRay = Math.ceil(maxOverallRange / stepMeters);

        // 1. Collect points for terrain query
        const cartographics: Cesium.Cartographic[] = [];
        const radarCenter = Cesium.Cartographic.fromDegrees(longitude, latitude);
        cartographics.push(radarCenter);

        for (let a = 0; a < numAzimuths; a++) {
            const azimuthRad = (a / numAzimuths) * Cesium.Math.TWO_PI;

            for (let s = 1; s <= stepsPerRay; s++) {
                const dist = Math.min(s * stepMeters, maxOverallRange);
                const { lon, lat } = this.destinationCoordinate(longitude, latitude, dist, azimuthRad);
                cartographics.push(Cesium.Cartographic.fromDegrees(lon, lat));
            }
        }

        // Fast, camera-independent terrain sampling
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

        const groundAltitude = cartographics[0].height || 0;
        const radarOriginAlt = groundAltitude + antennaMastHeight;

        // 2. Line of Sight (LOS) and 3D Shadow Line calculation
        // For each ray, compute the shadow height profile along distance
        interface AzimuthProfile {
            // Obstacle distance per zone (where ceiling is hit)
            zoneEndDists: number[];
            // Shadow elevation at the end of each zone
            zoneShadowHeights: number[];
            // Terrain elevation at the end of each zone
            zoneTerrainHeights: number[];
        }

        const profiles: AzimuthProfile[] = [];

        // Moving-average window (in samples) used to smooth raw terrain
        // heights before they feed the slope/shadow calculation. Real DEM
        // data has small noise/bumps of a few meters between sample points;
        // without smoothing, a single noisy sample can permanently distort
        // the "shadow line" for the rest of that ray (since maxSlope only
        // ever increases), producing sharp fake notches even on flat ground.
        const SMOOTH_WINDOW = 3;

        for (let a = 0; a < numAzimuths; a++) {
            const rayStartIndex = 1 + a * stepsPerRay;

            // Raw terrain heights for this ray, pulled once up front so we
            // can smooth them before the slope/shadow pass below.
            const rawTerrainForRay: number[] = [];
            for (let s = 1; s <= stepsPerRay; s++) {
                const sample = cartographics[rayStartIndex + s - 1];
                rawTerrainForRay.push(sample?.height ?? groundAltitude);
            }

            // Simple centered moving average to suppress single-sample noise.
            const smoothedTerrainForRay: number[] = rawTerrainForRay.map((_, i) => {
                const lo = Math.max(0, i - Math.floor(SMOOTH_WINDOW / 2));
                const hi = Math.min(rawTerrainForRay.length - 1, i + Math.floor(SMOOTH_WINDOW / 2));
                let sum = 0;
                for (let k = lo; k <= hi; k++) sum += rawTerrainForRay[k];
                return sum / (hi - lo + 1);
            });

            let maxSlope = -Infinity;
            let greenEndDist = zones[0].maxRange;
            let yellowEndDist = zones[1].maxRange;
            let redEndDist = zones[2].maxRange;

            let greenHit = false;
            let yellowHit = false;
            let redHit = false;

            const shadowHeightAtDist: number[] = [];
            const terrainHeightAtDist: number[] = [];

            for (let s = 1; s <= stepsPerRay; s++) {
                const dist = Math.min(s * stepMeters, maxOverallRange);
                // Use the smoothed height for slope/shadow math (reduces
                // false positives), but keep the raw height available too
                // since the actual wall geometry should still hug real terrain.
                const terrainH = smoothedTerrainForRay[s - 1];

                terrainHeightAtDist.push(terrainH);

                // Earth curvature drop
                const earthDrop = (dist * dist) / (2 * 6378137);

                // Slope from antenna to this terrain point
                const slope = (terrainH + earthDrop - radarOriginAlt) / dist;
                if (slope > maxSlope) {
                    maxSlope = slope;
                }

                // FIX: cap the running max slope so distant shadow heights
                // can't run away to infinity from one nearby steep ridge.
                if (maxSlope > this.MAX_SLOPE) {
                    maxSlope = this.MAX_SLOPE;
                }

                // Minimum visible height at this distance (the 3D shadow line)
                const shadowAlt = radarOriginAlt + dist * maxSlope - earthDrop;
                shadowHeightAtDist.push(shadowAlt);

                // Check Green Zone (400m ceiling)
                const greenCeilingAbs = groundAltitude + zones[0].ceilingHeight - earthDrop;
                if (!greenHit && (terrainH >= greenCeilingAbs || shadowAlt >= greenCeilingAbs)) {
                    greenEndDist = dist;
                    greenHit = true;
                }

                // Check Yellow Zone (900m ceiling)
                const yellowCeilingAbs = groundAltitude + zones[1].ceilingHeight - earthDrop;
                if (!yellowHit && (terrainH >= yellowCeilingAbs || shadowAlt >= yellowCeilingAbs)) {
                    yellowEndDist = dist;
                    yellowHit = true;
                }

                // Check Red Zone (1600m ceiling)
                const redCeilingAbs = groundAltitude + zones[2].ceilingHeight - earthDrop;
                if (!redHit && (terrainH >= redCeilingAbs || shadowAlt >= redCeilingAbs)) {
                    redEndDist = dist;
                    redHit = true;
                }
            }

            // FIX: a zone's boundary must never extend past its own configured
            // maxRange, no matter what the terrain does farther out. Previously
            // the hit-scan ran all the way to maxOverallRange (e.g. 20000m) for
            // EVERY zone's check, so on gently-rising "flat looking" ground the
            // green zone's 400m ceiling might not be crossed until 12000m+ out,
            // stretching a green tongue far past its own ring and straight
            // through mountains in between (and across yellow's boundary).
            greenEndDist = Math.min(greenEndDist, zones[0].maxRange);
            yellowEndDist = Math.min(yellowEndDist, zones[1].maxRange);
            redEndDist = Math.min(redEndDist, zones[2].maxRange);

            // Get shadow & terrain height at the effective boundary of each zone
            const getHeightsAtDist = (targetDist: number) => {
                const idx = Math.min(Math.max(1, Math.round(targetDist / stepMeters)), stepsPerRay) - 1;
                return {
                    shadowH: shadowHeightAtDist[idx] ?? groundAltitude,
                    terrainH: terrainHeightAtDist[idx] ?? groundAltitude
                };
            };

            const gH = getHeightsAtDist(greenEndDist);
            const yH = getHeightsAtDist(yellowEndDist);
            const rH = getHeightsAtDist(redEndDist);

            profiles.push({
                zoneEndDists: [greenEndDist, yellowEndDist, redEndDist],
                zoneShadowHeights: [gH.shadowH, yH.shadowH, rH.shadowH],
                zoneTerrainHeights: [gH.terrainH, yH.terrainH, rH.terrainH]
            });
        }

        const createdEntities: Cesium.Entity[] = [];

        // 3. Build the 3D Cylinders with FLOATING bottoms
        for (let zIdx = zones.length - 1; zIdx >= 0; zIdx--) {
            const zone = zones[zIdx];
            const ceilingAltitude = groundAltitude + zone.ceilingHeight;

            const wallTopCartesians: Cesium.Cartesian3[] = [];
            const wallBottomHeights: number[] = [];
            const capCartesians: Cesium.Cartesian3[] = [];

            for (let a = 0; a < numAzimuths; a++) {
                const azimuthRad = (a / numAzimuths) * Cesium.Math.TWO_PI;
                const profile = profiles[a];

                const effectiveDist = profile.zoneEndDists[zIdx];
                const shadowAlt = profile.zoneShadowHeights[zIdx];
                const terrainAlt = profile.zoneTerrainHeights[zIdx];

                const { lon, lat } = this.destinationCoordinate(
                    longitude,
                    latitude,
                    effectiveDist,
                    azimuthRad
                );

                // The bottom of the wall FLOATS at shadowAlt if a mountain blocked the lower rays.
                // It never drops down below the actual terrain either.
                const floatingBottom = Math.max(terrainAlt, shadowAlt);

                // FIX: the wall top must ALWAYS sit exactly at the ceiling —
                // never let floatingBottom push it higher. Previously this was
                // Math.max(ceilingAltitude, floatingBottom + 5), which let the
                // top shoot above the ceiling and produced spikes above ridgelines.
                const safeTopHeight = ceilingAltitude;
                const safeBottomHeight = Math.min(floatingBottom, safeTopHeight - 2);

                const topPos = Cesium.Cartesian3.fromDegrees(lon, lat, safeTopHeight);
                wallTopCartesians.push(topPos);
                wallBottomHeights.push(safeBottomHeight);

                capCartesians.push(topPos);
            }

            // Close wall loop
            wallTopCartesians.push(wallTopCartesians[0]);
            wallBottomHeights.push(wallBottomHeights[0]);

            // A. 3D Vertical Curtain Wall
            // In open areas: Touches the ground.
            // Behind mountains: FLOATS high in the sky at the shadow line,
            // but its top is always flush with the flat ceiling cap.
            const wallEntity = viewer.entities.add({
                name: `${zone.name} 3D Wall`,
                wall: {
                    positions: wallTopCartesians,
                    minimumHeights: wallBottomHeights,
                    material: zone.color.withAlpha(zone.wallAlpha),
                    outline: true,
                    outlineColor: zone.color.withAlpha(0.9),
                    outlineWidth: 2
                }
            });
            createdEntities.push(wallEntity);

            // B. 3D Flat Top Ceiling Cap
            const capEntity = viewer.entities.add({
                name: `${zone.name} Top Cap`,
                polygon: {
                    hierarchy: new Cesium.PolygonHierarchy(capCartesians),
                    height: ceilingAltitude,
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