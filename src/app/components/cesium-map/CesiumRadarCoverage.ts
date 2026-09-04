import * as Cesium from "cesium";

export interface Zone3DConfig {
    name: string;
    maxRange: number;       // Max radius in meters
    ceilingHeight: number;  // Height above radar site in meters
    color: Cesium.Color;
    wallAlpha: number;
    capAlpha: number;
}

export interface Radar3DOptions {
    longitude: number;
    latitude: number;
    antennaMastHeight?: number; // Antenna elevation above ground (e.g. 25m)
    numAzimuths?: number;       // Number of angles around 360 (72 = 5-degree steps)
    zones?: Zone3DConfig[];
}

export class Cesium3DRadarCoverage {
    /**
     * 3 Stacked 3D Zones:
     * - Green: Low altitude (400m ceiling) -> stops at small hills
     * - Yellow: Medium altitude (900m ceiling) -> passes over small hills, stops at medium peaks
     * - Red: High altitude (1600m ceiling) -> passes over medium ridges, stops only at massive peaks
     */
    public static readonly DEFAULT_3D_ZONES: Zone3DConfig[] = [
        {
            name: "Low-Altitude Engagement (Green)",
            maxRange: 5000,
            ceilingHeight: 400,
            color: Cesium.Color.fromCssColorString("#10B981"),
            wallAlpha: 0.35,
            capAlpha: 0.25
        },
        {
            name: "Mid-Altitude Tracking (Yellow)",
            maxRange: 12000,
            ceilingHeight: 900,
            color: Cesium.Color.fromCssColorString("#F59E0B"),
            wallAlpha: 0.30,
            capAlpha: 0.20
        },
        {
            name: "High-Altitude Early Warning (Red)",
            maxRange: 20000,
            ceilingHeight: 1600,
            color: Cesium.Color.fromCssColorString("#EF4444"),
            wallAlpha: 0.25,
            capAlpha: 0.15
        }
    ];

    /**
     * Builds true 3D volumetric radar cylinders with independent altitude blocking.
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
            numAzimuths = 72,
            zones = this.DEFAULT_3D_ZONES
        } = options;

        const maxOverallRange = Math.max(...zones.map(z => z.maxRange));
        const stepMeters = 250;
        const stepsPerRay = Math.ceil(maxOverallRange / stepMeters);

        // 1. Gather coordinates to sample at fixed LOD Level 11 (camera-independent)
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

        // Safe terrain sampling with multi-level fallback
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

        // 2. Compute the obstruction distance INDEPENDENTLY for each zone
        const zoneObstacleDistances: number[][] = zones.map(() => []);

        for (let a = 0; a < numAzimuths; a++) {
            const rayStartIndex = 1 + a * stepsPerRay;

            for (let zIdx = 0; zIdx < zones.length; zIdx++) {
                const zone = zones[zIdx];
                const zoneCeilingAbs = groundAltitude + zone.ceilingHeight;
                let hitDist: number | null = null;

                for (let s = 1; s <= stepsPerRay; s++) {
                    const dist = Math.min(s * stepMeters, zone.maxRange);
                    const sample = cartographics[rayStartIndex + s - 1];
                    const terrainHeight = sample?.height ?? 0;

                    // Earth curvature drop
                    const earthDrop = (dist * dist) / (2 * 6378137);
                    const zoneLOSHeight = zoneCeilingAbs - earthDrop;

                    // Zone stops ONLY if mountain is taller than its ceiling!
                    if (terrainHeight >= zoneLOSHeight) {
                        hitDist = dist;
                        break;
                    }

                    if (dist >= zone.maxRange) break;
                }

                zoneObstacleDistances[zIdx].push(hitDist !== null ? hitDist : zone.maxRange);
            }
        }

        const createdEntities: Cesium.Entity[] = [];

        // 3. Construct 3D Vertical Curtain Walls and 3D Top Caps
        for (let zIdx = zones.length - 1; zIdx >= 0; zIdx--) {
            const zone = zones[zIdx];
            const obstacleDists = zoneObstacleDistances[zIdx];
            const ceilingAltitude = groundAltitude + zone.ceilingHeight;

            const wallTopCartesians: Cesium.Cartesian3[] = [];
            const wallBottomHeights: number[] = [];
            const capCartesians: Cesium.Cartesian3[] = [];

            for (let a = 0; a < numAzimuths; a++) {
                const azimuthRad = (a / numAzimuths) * Cesium.Math.TWO_PI;
                const effectiveDist = Math.min(zone.maxRange, obstacleDists[a]);

                const { lon, lat } = this.destinationCoordinate(
                    longitude,
                    latitude,
                    effectiveDist,
                    azimuthRad
                );

                const stepIndex = Math.min(Math.round(effectiveDist / stepMeters), stepsPerRay);
                const terrainSample = cartographics[1 + a * stepsPerRay + Math.max(0, stepIndex - 1)];
                const localTerrainH = terrainSample?.height ?? groundAltitude;

                // BUG FIX: Prevent minimumHeight > height inversion
                const safeTopHeight = Math.max(ceilingAltitude, localTerrainH + 2);
                const safeBottomHeight = Math.min(localTerrainH, ceilingAltitude - 2);

                const topPos = Cesium.Cartesian3.fromDegrees(lon, lat, safeTopHeight);
                wallTopCartesians.push(topPos);
                wallBottomHeights.push(safeBottomHeight);

                // Cap boundary
                capCartesians.push(topPos);
            }

            // Close the loop
            wallTopCartesians.push(wallTopCartesians[0]);
            wallBottomHeights.push(wallBottomHeights[0]);

            // A. 3D Vertical Curtain Wall
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

        // 4. Clean 3D Line-of-Sight Rays terminating on the terrain
        const radarAntennaPos = Cesium.Cartesian3.fromDegrees(longitude, latitude, radarOriginAlt);
        const rayStride = Math.floor(numAzimuths / 18); // 18 rays

        for (let a = 0; a < numAzimuths; a += rayStride) {
            const azimuthRad = (a / numAzimuths) * Cesium.Math.TWO_PI;
            const hitDist = zoneObstacleDistances[0][a]; // Innermost zone hit
            const { lon, lat } = this.destinationCoordinate(longitude, latitude, hitDist, azimuthRad);

            const stepIndex = Math.min(Math.round(hitDist / stepMeters), stepsPerRay);
            const terrainSample = cartographics[1 + a * stepsPerRay + Math.max(0, stepIndex - 1)];
            const hitTerrainH = terrainSample?.height ?? groundAltitude;

            const endPos = Cesium.Cartesian3.fromDegrees(lon, lat, hitTerrainH + 5);

            const rayEntity = viewer.entities.add({
                polyline: {
                    positions: [radarAntennaPos, endPos],
                    width: 1.5,
                    arcType: Cesium.ArcType.NONE,
                    material: Cesium.Color.fromCssColorString("#00E5FF").withAlpha(0.65)
                }
            });
            createdEntities.push(rayEntity);
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