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
            name: "Low-Altitude (Green)",
            maxRange: 5000,
            ceilingHeight: 400, // 400m ceiling
            color: Cesium.Color.fromCssColorString("#10B981"),
            wallAlpha: 0.35,
            capAlpha: 0.25
        },
        {
            name: "Mid-Altitude (Yellow)",
            maxRange: 12000,
            ceilingHeight: 900, // 900m ceiling
            color: Cesium.Color.fromCssColorString("#F59E0B"),
            wallAlpha: 0.30,
            capAlpha: 0.20
        },
        {
            name: "High-Altitude (Red/Pink)",
            maxRange: 20000,
            ceilingHeight: 1600, // 1600m ceiling
            color: Cesium.Color.fromCssColorString("#EF4444"),
            wallAlpha: 0.25,
            capAlpha: 0.15
        }
    ];

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
            numAzimuths = 72,
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

        for (let a = 0; a < numAzimuths; a++) {
            const rayStartIndex = 1 + a * stepsPerRay;

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
                const sample = cartographics[rayStartIndex + s - 1];
                const terrainH = sample?.height ?? groundAltitude;

                terrainHeightAtDist.push(terrainH);

                // Earth curvature drop
                const earthDrop = (dist * dist) / (2 * 6378137);

                // Slope from antenna to this terrain point
                const slope = (terrainH + earthDrop - radarOriginAlt) / dist;
                if (slope > maxSlope) {
                    maxSlope = slope;
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

                // KEY FIX: The bottom of the wall FLOATS at shadowAlt if a mountain blocked the lower rays!
                // It NEVER drops down to the river bed!
                const floatingBottom = Math.max(terrainAlt, shadowAlt);

                const safeTopHeight = Math.max(ceilingAltitude, floatingBottom + 5);
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
            // Behind mountains: FLOATS high in the sky at the shadow line!
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

        // 4. Draw Line-of-Sight rays from radar to obstacle hits
        const radarAntennaPos = Cesium.Cartesian3.fromDegrees(longitude, latitude, radarOriginAlt);
        const rayStride = Math.floor(numAzimuths / 24);

        for (let a = 0; a < numAzimuths; a += rayStride) {
            const azimuthRad = (a / numAzimuths) * Cesium.Math.TWO_PI;
            const hitDist = profiles[a].zoneEndDists[0]; // Green hit
            const { lon, lat } = this.destinationCoordinate(longitude, latitude, hitDist, azimuthRad);
            const hitTerrain = profiles[a].zoneTerrainHeights[0];

            const endPos = Cesium.Cartesian3.fromDegrees(lon, lat, hitTerrain + 5);

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