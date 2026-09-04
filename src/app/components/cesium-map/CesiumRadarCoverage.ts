import * as Cesium from "cesium";

export interface RadarZoneConfig {
    name: string;
    radius: number;        // Max range in meters
    ceilingHeight: number; // Height of curtain above radar in meters
    color: Cesium.Color;
    alpha: number;
}

export interface TerrainRadarOptions {
    longitude: number;
    latitude: number;
    antennaHeight?: number;  // Mast height above ground (e.g. 15m)
    numAzimuths?: number;    // Number of angles around 360 (e.g. 120 = every 3 degrees)
    zones?: RadarZoneConfig[];
}

export class CesiumTerrainRadarCoverage {
    public static readonly DEFAULT_ZONES: RadarZoneConfig[] = [
        {
            name: "Close Range / Lethal",
            radius: 5000,
            ceilingHeight: 300,
            color: Cesium.Color.fromCssColorString("#10B981"), // Green
            alpha: 0.35
        },
        {
            name: "Medium Range / Tracking",
            radius: 12000,
            ceilingHeight: 600,
            color: Cesium.Color.fromCssColorString("#F59E0B"), // Amber/Yellow
            alpha: 0.30
        },
        {
            name: "Max Range / Early Warning",
            radius: 20000,
            ceilingHeight: 1000,
            color: Cesium.Color.fromCssColorString("#EF4444"), // Red
            alpha: 0.25
        }
    ];

    /**
     * Calculates terrain-blocked boundaries and creates 3D curtains + top caps
     * that physically terminate at mountain obstacles.
     */
    static buildTerrainAwareRadar(
        viewer: Cesium.Viewer,
        options: TerrainRadarOptions
    ): Cesium.Entity[] {
        const {
            longitude,
            latitude,
            antennaHeight = 20,
            numAzimuths = 120, // 3-degree resolution
            zones = this.DEFAULT_ZONES
        } = options;

        const globe = viewer.scene.globe;
        const maxOverallRange = Math.max(...zones.map(z => z.radius));

        // 1. Get radar ground elevation from loaded scene terrain
        const siteCarto = Cesium.Cartographic.fromDegrees(longitude, latitude);
        const sampledGround = globe.getHeight(siteCarto);
        const groundAltitude = sampledGround !== undefined && !isNaN(sampledGround) ? sampledGround : 0;
        const radarAltitude = groundAltitude + antennaHeight;

        // 2. Compute the terrain obstacle distance for every azimuth angle (0 to 360 deg)
        const obstacleDistances: number[] = [];
        const stepSize = 200; // Step size in meters for ray marching
        const maxSteps = Math.ceil(maxOverallRange / stepSize);

        const scratchCarto = new Cesium.Cartographic();

        for (let i = 0; i < numAzimuths; i++) {
            const azimuthDeg = (i / numAzimuths) * 360;
            const azimuthRad = Cesium.Math.toRadians(azimuthDeg);
            const sinAz = Math.sin(azimuthRad);
            const cosAz = Math.cos(azimuthRad);

            let blockedDist: number | null = null;
            let prevDist = 0;

            for (let step = 1; step <= maxSteps; step++) {
                const dist = Math.min(step * stepSize, maxOverallRange);

                // Precise great-circle destination
                const { lon: sampleLon, lat: sampleLat } = this.destinationCoordinate(
                    longitude,
                    latitude,
                    dist,
                    azimuthRad
                );

                scratchCarto.longitude = Cesium.Math.toRadians(sampleLon);
                scratchCarto.latitude = Cesium.Math.toRadians(sampleLat);

                const terrainHeight = globe.getHeight(scratchCarto);

                if (terrainHeight !== undefined && !isNaN(terrainHeight)) {
                    // Line-of-sight height accounting for Earth curvature
                    const earthDrop = (dist * dist) / (2 * 6378137);
                    const losHeight = radarAltitude - earthDrop;

                    // If terrain rises above line-of-sight, mountain blocks the radar!
                    if (terrainHeight >= losHeight) {
                        // Binary search to find exact mountain edge
                        blockedDist = this.binarySearchRefine(
                            globe,
                            longitude,
                            latitude,
                            radarAltitude,
                            azimuthRad,
                            prevDist,
                            dist,
                            5
                        );
                        break;
                    }
                }

                prevDist = dist;
                if (dist >= maxOverallRange) break;
            }

            obstacleDistances.push(blockedDist !== null ? blockedDist : maxOverallRange);
        }

        const createdEntities: Cesium.Entity[] = [];

        // 3. Generate terrain-clipped 3D Wall Curtains and Polygons for each zone
        // Sort largest radius first
        const sortedZones = [...zones].sort((a, b) => b.radius - a.radius);

        for (const zone of sortedZones) {
            const topPositions: Cesium.Cartesian3[] = [];
            const bottomHeights: number[] = [];
            const polygonHierarchyPositions: Cesium.Cartesian3[] = [];

            for (let i = 0; i < numAzimuths; i++) {
                const azimuthRad = Cesium.Math.toRadians((i / numAzimuths) * 360);

                // CLAMP: The radius CANNOT exceed the mountain distance!
                const effectiveDist = Math.min(zone.radius, obstacleDistances[i]);

                const { lon, lat } = this.destinationCoordinate(
                    longitude,
                    latitude,
                    effectiveDist,
                    azimuthRad
                );

                scratchCarto.longitude = Cesium.Math.toRadians(lon);
                scratchCarto.latitude = Cesium.Math.toRadians(lat);
                const terrainH = globe.getHeight(scratchCarto) || groundAltitude;

                // Wall top height = ground elevation at radar + zone ceiling height
                const wallTopHeight = groundAltitude + zone.ceilingHeight;

                const topCartesian = Cesium.Cartesian3.fromDegrees(lon, lat, wallTopHeight);
                topPositions.push(topCartesian);
                bottomHeights.push(terrainH);

                // Polygon cap position
                polygonHierarchyPositions.push(
                    Cesium.Cartesian3.fromDegrees(lon, lat, wallTopHeight)
                );
            }

            // Close the loop
            topPositions.push(topPositions[0]);
            bottomHeights.push(bottomHeights[0]);

            // A. Vertical 3D Curtain Wall that hugs the terrain and stops at mountain faces
            const wallEntity = viewer.entities.add({
                name: `${zone.name} Wall`,
                wall: {
                    positions: topPositions,
                    minimumHeights: bottomHeights,
                    material: zone.color.withAlpha(zone.alpha),
                    outline: true,
                    outlineColor: zone.color.withAlpha(0.9),
                    outlineWidth: 2
                }
            });
            createdEntities.push(wallEntity);

            // B. Top Cap of the Cylinder
            const topCapEntity = viewer.entities.add({
                name: `${zone.name} Top Cap`,
                polygon: {
                    hierarchy: new Cesium.PolygonHierarchy(polygonHierarchyPositions),
                    height: groundAltitude + zone.ceilingHeight,
                    material: zone.color.withAlpha(zone.alpha * 0.75),
                    outline: false
                }
            });
            createdEntities.push(topCapEntity);
        }

        // 4. Draw Radial Sweep Lines that terminate right on the mountain face
        const radarOriginCartesian = Cesium.Cartesian3.fromDegrees(longitude, latitude, radarAltitude);

        // Draw sample rays every 10 degrees for visual confirmation
        const rayStride = Math.floor(numAzimuths / 36);
        for (let i = 0; i < numAzimuths; i += rayStride) {
            const azimuthRad = Cesium.Math.toRadians((i / numAzimuths) * 360);
            const effectiveDist = obstacleDistances[i];
            const isBlocked = effectiveDist < maxOverallRange;

            const { lon, lat } = this.destinationCoordinate(
                longitude,
                latitude,
                effectiveDist,
                azimuthRad
            );

            scratchCarto.longitude = Cesium.Math.toRadians(lon);
            scratchCarto.latitude = Cesium.Math.toRadians(lat);
            const hitGround = globe.getHeight(scratchCarto) || groundAltitude;

            const endCartesian = Cesium.Cartesian3.fromDegrees(
                lon,
                lat,
                isBlocked ? hitGround + 5 : radarAltitude
            );

            const rayEntity = viewer.entities.add({
                polyline: {
                    positions: [radarOriginCartesian, endCartesian],
                    width: isBlocked ? 2 : 1,
                    arcType: Cesium.ArcType.NONE,
                    material: isBlocked
    ? Cesium.Color.fromCssColorString("#22D3EE").withAlpha(0.95)
    : Cesium.Color.fromCssColorString("#60A5FA").withAlpha(0.35),
                    clampToGround: false
                }
            });
            createdEntities.push(rayEntity);
        }

        return createdEntities;
    }

    /**
     * Great-Circle destination coordinate given origin, distance, and azimuth.
     */
    private static destinationCoordinate(
        lonDeg: number,
        latDeg: number,
        distMeters: number,
        bearingRad: number
    ): { lon: number; lat: number } {
        const R = 6378137.0; // Earth radius (m)
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

    /**
     * Binary search refinement to pinpoint the exact mountain collision point.
     */
    private static binarySearchRefine(
        globe: Cesium.Globe,
        originLon: number,
        originLat: number,
        radarAlt: number,
        azimuthRad: number,
        lowDist: number,
        highDist: number,
        iterations: number
    ): number {
        let low = lowDist;
        let high = highDist;
        const scratch = new Cesium.Cartographic();

        for (let it = 0; it < iterations; it++) {
            const mid = (low + high) * 0.5;
            const { lon, lat } = this.destinationCoordinate(originLon, originLat, mid, azimuthRad);

            scratch.longitude = Cesium.Math.toRadians(lon);
            scratch.latitude = Cesium.Math.toRadians(lat);

            const hTerrain = globe.getHeight(scratch);
            const hLOS = radarAlt - (mid * mid) / (2 * 6378137);

            if (hTerrain !== undefined && !isNaN(hTerrain) && hTerrain >= hLOS) {
                high = mid; // Blocked earlier
            } else {
                low = mid;  // Clear at this distance
            }
        }

        return high;
    }
}