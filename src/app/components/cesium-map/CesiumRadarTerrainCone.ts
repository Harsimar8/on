import * as Cesium from "cesium";

export interface RadarTerrainConeOptions {
    longitude: number;
    latitude: number;
    altitude: number;

    range: number;

    heading: number;
    horizontalAngle: number;
    verticalAngle: number;

    horizontalRays: number;
    verticalRays: number;

    /**
     * Distance in meters between terrain samples along each ray.
     * Smaller = more accurate blocking point, but more terrain
     * requests and slower. 50–150m is a good starting range.
     */
    stepSize?: number;
}

export interface RadarTerrainRayResult {
    endPosition: Cesium.Cartesian3;
    blocked: boolean;
}

interface RaySample {
    distance: number;
    rayHeight: number;                 // ray's ellipsoid height at this distance
    cartesianPoint: Cesium.Cartesian3; // ray's 3D position at this distance
    cartographic: Cesium.Cartographic; // gets overwritten with terrain height
}

export class CesiumRadarTerrainCone {

    /**
     * Calculate terrain-blocked radar rays WITHOUT scene.pickFromRay()
     * or globe.pick().
     *
     * Each ray is marched outward in `stepSize` increments up to `range`.
     * Every sample point from EVERY ray is batched into a single
     * Cesium.sampleTerrainMostDetailed() call, which asks the terrain
     * provider for the real ground height at each lon/lat — regardless
     * of what's currently loaded/rendered in the scene.
     *
     * A ray is "blocked" at the first sample where its height drops
     * to/below the sampled terrain height. The exact crossing point is
     * then linearly interpolated between the last clear sample and the
     * first blocked sample, so results aren't limited to stepSize
     * resolution.
     */
    static async calculate(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: RadarTerrainConeOptions
    ): Promise<RadarTerrainRayResult[]> {

        const {
            longitude,
            latitude,
            altitude,
            range,
            heading,
            horizontalAngle,
            verticalAngle,
            horizontalRays,
            verticalRays,
            stepSize = 100
        } = options;

        const radarPosition =
            Cesium.Cartesian3.fromDegrees(
                longitude,
                latitude,
                altitude
            );

        const enuTransform =
            Cesium.Transforms.eastNorthUpToFixedFrame(
                radarPosition
            );

        interface RayDef {
            ray: Cesium.Ray;
            maxRangePosition: Cesium.Cartesian3;
        }

        const rays: RayDef[] = [];

        for (
            let horizontalIndex = 0;
            horizontalIndex < horizontalRays;
            horizontalIndex++
        ) {

            const horizontalFraction =
                horizontalRays === 1
                    ? 0
                    : horizontalIndex / horizontalRays;

            const horizontalRadians =
                Cesium.Math.toRadians(heading) +
                horizontalFraction *
                Cesium.Math.toRadians(horizontalAngle);

            for (
                let verticalIndex = 0;
                verticalIndex < verticalRays;
                verticalIndex++
            ) {

                const verticalFraction =
                    verticalRays === 1
                        ? 0.5
                        : verticalIndex / (verticalRays - 1);

                const verticalDegrees =
                    -verticalAngle / 2 +
                    verticalFraction * verticalAngle;

                const verticalRadians =
                    Cesium.Math.toRadians(verticalDegrees);

                const horizontalCos = Math.cos(verticalRadians);

                const localDirection =
                    new Cesium.Cartesian3(
                        Math.sin(horizontalRadians) * horizontalCos,
                        Math.cos(horizontalRadians) * horizontalCos,
                        Math.sin(verticalRadians)
                    );

                const worldDirection =
                    Cesium.Matrix4.multiplyByPointAsVector(
                        enuTransform,
                        localDirection,
                        new Cesium.Cartesian3()
                    );

                Cesium.Cartesian3.normalize(worldDirection, worldDirection);

                const ray = new Cesium.Ray(radarPosition, worldDirection);

                const maxRangePosition =
                    Cesium.Ray.getPoint(ray, range, new Cesium.Cartesian3());

                rays.push({ ray, maxRangePosition });
            }
        }

        /*
         * March every ray, collecting sample points. All samples
         * from all rays get batched into ONE sampleTerrainMostDetailed
         * call for efficiency.
         */
        const samplesByRay: RaySample[][] = rays.map(() => []);
        const allCartographics: Cesium.Cartographic[] = [];

        for (let rayIndex = 0; rayIndex < rays.length; rayIndex++) {

            const { ray } = rays[rayIndex];

            for (let distance = stepSize; distance <= range; distance += stepSize) {

                const point =
                    Cesium.Ray.getPoint(ray, distance, new Cesium.Cartesian3());

                const rayCartographic =
                    Cesium.Cartographic.fromCartesian(point);

                if (!rayCartographic) {
                    continue;
                }

                // clone: sampleTerrainMostDetailed will overwrite
                // .height on this object with the terrain height,
                // so we keep rayHeight separately.
                const terrainCartographic =
                    Cesium.Cartographic.clone(rayCartographic);

                const sample: RaySample = {
                    distance,
                    rayHeight: rayCartographic.height,
                    cartesianPoint: point,
                    cartographic: terrainCartographic
                };

                samplesByRay[rayIndex].push(sample);
                allCartographics.push(terrainCartographic);
            }
        }

        /*
         * This is the replacement for scene.pickFromRay() / globe.pick().
         * It queries the terrain provider directly for ground height,
         * independent of what tiles happen to be rendered right now.
         */
        if (allCartographics.length > 0) {
            await Cesium.sampleTerrainMostDetailed(
                terrainProvider,
                allCartographics
            );
        }

        const results: RadarTerrainRayResult[] = [];

        for (let rayIndex = 0; rayIndex < rays.length; rayIndex++) {

            const { maxRangePosition, ray } = rays[rayIndex];
            const samples = samplesByRay[rayIndex];

            let hitSample: RaySample | null = null;
            let prevSample: RaySample | null = null;

            for (const sample of samples) {

                const terrainHeight = sample.cartographic.height;

                if (sample.rayHeight <= terrainHeight) {
                    hitSample = sample;
                    break;
                }

                prevSample = sample;
            }

            if (!hitSample) {
                results.push({
                    endPosition: maxRangePosition,
                    blocked: false
                });
                continue;
            }

            // Interpolate the exact crossing point so the hit
            // isn't blocky/limited to stepSize resolution.
            let hitPosition = hitSample.cartesianPoint;

            if (prevSample) {

                const prevDiff = prevSample.rayHeight - prevSample.cartographic.height;
                const hitDiff = hitSample.rayHeight - hitSample.cartographic.height;
                const denom = prevDiff - hitDiff;

                const t = denom !== 0
                    ? Cesium.Math.clamp(prevDiff / denom, 0, 1)
                    : 0;

                const interpDistance =
                    Cesium.Math.lerp(prevSample.distance, hitSample.distance, t);

                hitPosition = Cesium.Ray.getPoint(
                    ray,
                    interpDistance,
                    new Cesium.Cartesian3()
                );
            }

            results.push({
                endPosition: hitPosition,
                blocked: true
            });
        }

        return results;
    }
}