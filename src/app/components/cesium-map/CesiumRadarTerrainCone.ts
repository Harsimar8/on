import * as Cesium from "cesium";

export interface RadarTerrainConeOptions {
    longitude: number;
    latitude: number;
    altitude: number;
    range: number;
    heading: number;
    horizontalAngle: number;
    verticalAngle: number;
    horizontalRays?: number;
    verticalRays?: number;
}

export interface RadarRay {
    azimuthIndex: number;
    elevationIndex: number;
    start: Cesium.Cartesian3;
    direction: Cesium.Cartesian3;
}

export interface RayResult {
    ray: RadarRay;
    distance: number;
    endPosition: Cesium.Cartesian3;
    blocked: boolean;
}

export class CesiumRadarTerrainCone {

    static async calculate(
        viewer: Cesium.Viewer,
        options: RadarTerrainConeOptions
    ): Promise<RayResult[]> {

        const horizontalRays =
            options.horizontalRays ?? 360;

        const verticalRays =
            options.verticalRays ?? 1;

        const radarPosition =
            Cesium.Cartesian3.fromDegrees(
                options.longitude,
                options.latitude,
                options.altitude
            );

        const rays =
            this.generateRays(
                radarPosition,
                options.heading,
                options.horizontalAngle,
                options.verticalAngle,
                horizontalRays,
                verticalRays
            );

        const results: RayResult[] = [];

        /*
         * IMPORTANT:
         * Do all ray picks asynchronously.
         */
        const rayPromises = rays.map(async (ray) => {

            const cesiumRay =
                new Cesium.Ray(
                    ray.start,
                    ray.direction
                );

            const maxPoint =
                Cesium.Ray.getPoint(
                    cesiumRay,
                    options.range
                );

            const hit =
                await this.findNearestIntersection(
                    viewer,
                    cesiumRay,
                    options.range
                );

            if (hit) {
                return {
                    ray,
                    distance: hit.distance,
                    endPosition: hit.position,
                    blocked: true
                };
            }

            return {
                ray,
                distance: options.range,
                endPosition: maxPoint,
                blocked: false
            };
        });

        const resolved =
            await Promise.all(rayPromises);

        results.push(...resolved);

        return results;
    }

    private static findNearestIntersection(
    viewer: Cesium.Viewer,
    ray: Cesium.Ray,
    maxRange: number
): {
    position: Cesium.Cartesian3;
    distance: number;
} | null {

    /*
     * Test the ray progressively.
     *
     * IMPORTANT:
     * We don't use one giant globe.pick().
     * We test points along the ray and compare their
     * height against the actual terrain height.
     */

    const STEP = 250.0; // meters

    const ellipsoid =
        viewer.scene.globe.ellipsoid;

    let previousDistance = 0;

    for (
        let distance = STEP;
        distance <= maxRange;
        distance += STEP
    ) {

        const point =
            Cesium.Ray.getPoint(
                ray,
                distance
            );

        const cartographic =
            ellipsoid.cartesianToCartographic(
                point
            );

        if (!cartographic) {
            continue;
        }

        /*
         * Terrain surface directly below this point.
         */
        const terrainHeight =
            viewer.scene.globe.getHeight(
                cartographic
            );

        if (
            terrainHeight !== undefined &&
            terrainHeight !== null
        ) {

            /*
             * Height of the radar ray.
             */
            const rayHeight =
                cartographic.height;

            /*
             * If terrain has reached/crossed the ray,
             * THIS is the obstruction.
             */
            if (
                terrainHeight >= rayHeight
            ) {

                /*
                 * Binary-search the previous 250 m
                 * interval to get a much more accurate
                 * obstruction point.
                 */
                let low = previousDistance;
                let high = distance;

                for (let i = 0; i < 8; i++) {

                    const mid =
                        (low + high) / 2;

                    const midPoint =
                        Cesium.Ray.getPoint(
                            ray,
                            mid
                        );

                    const midCartographic =
                        ellipsoid.cartesianToCartographic(
                            midPoint
                        );

                    if (!midCartographic) {
                        break;
                    }

                    const midTerrain =
                        viewer.scene.globe.getHeight(
                            midCartographic
                        );

                    if (
                        midTerrain !== undefined &&
                        midTerrain !== null &&
                        midTerrain >=
                            midCartographic.height
                    ) {
                        high = mid;
                    } else {
                        low = mid;
                    }
                }

                const hitDistance =
                    high;

                const hitPosition =
                    Cesium.Ray.getPoint(
                        ray,
                        hitDistance
                    );

                return {
                    position: hitPosition,
                    distance: hitDistance
                };
            }
        }

        previousDistance = distance;
    }

    return null;
}

    private static generateRays(
        radarPosition: Cesium.Cartesian3,
        heading: number,
        horizontalAngle: number,
        verticalAngle: number,
        horizontalRays: number,
        verticalRays: number
    ): RadarRay[] {

        const rays: RadarRay[] = [];

        const headingRad =
            Cesium.Math.toRadians(
                heading
            );

        const halfHorizontal =
            Cesium.Math.toRadians(
                horizontalAngle / 2
            );

        const halfVertical =
            Cesium.Math.toRadians(
                verticalAngle / 2
            );

        const transform =
            Cesium.Transforms.eastNorthUpToFixedFrame(
                radarPosition
            );

        const rotation =
            Cesium.Matrix4.getMatrix3(
                transform,
                new Cesium.Matrix3()
            );

        for (
            let h = 0;
            h < horizontalRays;
            h++
        ) {

            /*
             * h / horizontalRays is intentional.
             *
             * It avoids creating the same ray twice
             * at 0° and 360°.
             */
            const horizontalT =
                horizontalRays === 1
                    ? 0.5
                    : h / horizontalRays;

            const azimuth =
                headingRad -
                halfHorizontal +
                horizontalT *
                halfHorizontal *
                2;

            for (
                let v = 0;
                v < verticalRays;
                v++
            ) {

                const verticalT =
                    verticalRays === 1
                        ? 0.5
                        : v /
                        (verticalRays - 1);

                const elevation =
                    -halfVertical +
                    verticalT *
                    halfVertical *
                    2;

                const localDirection =
                    new Cesium.Cartesian3(
                        Math.sin(azimuth) *
                        Math.cos(elevation),

                        Math.cos(azimuth) *
                        Math.cos(elevation),

                        Math.sin(elevation)
                    );

                const worldDirection =
                    Cesium.Matrix3.multiplyByVector(
                        rotation,
                        localDirection,
                        new Cesium.Cartesian3()
                    );

                Cesium.Cartesian3.normalize(
                    worldDirection,
                    worldDirection
                );

                rays.push({
                    azimuthIndex: h,
                    elevationIndex: v,
                    start: radarPosition,
                    direction: worldDirection
                });
            }
        }

        return rays;
    }
}