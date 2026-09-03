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
}

export interface RadarTerrainRayResult {
    endPosition: Cesium.Cartesian3;
    blocked: boolean;
}

export class CesiumRadarTerrainCone {

    /**
     * Calculate terrain-blocked radar rays.
     *
     * IMPORTANT:
     * This does NOT use globe.pick().
     *
     * Terrain is obtained using:
     *
     *     Cesium.sampleTerrainMostDetailed()
     *
     * Every ray is checked independently.
     * Once the FIRST terrain intersection is found,
     * that ray ends permanently at that point.
     */
    static async calculate(
        viewer: Cesium.Viewer,
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
            verticalRays
        } = options;

        /*
         * Radar position.
         */
        const radarPosition =
            Cesium.Cartesian3.fromDegrees(
                longitude,
                latitude,
                altitude
            );

        /*
         * Terrain provider.
         */
        const terrain = viewer.scene.terrain;

if (!terrain || !terrain.ready) {
    throw new Error("Cesium terrain is not ready.");
}

const terrainProvider = terrain.provider;

        /*
         * ENU coordinate system around radar.
         */
        const enuTransform =
            Cesium.Transforms.eastNorthUpToFixedFrame(
                radarPosition
            );

        /*
         * Number of terrain samples along
         * each ray.
         *
         * 100 m spacing for the first version.
         */
        const sampleSpacing = 25;

        const sampleCount =
            Math.max(
                2,
                Math.ceil(range / sampleSpacing) + 1
            );

        /*
         * Create all rays first.
         */
        const rays: Cesium.Ray[] = [];

        for (
            let horizontalIndex = 0;
            horizontalIndex < horizontalRays;
            horizontalIndex++
        ) {

            /*
             * Horizontal angle.
             */
            const horizontalFraction =
                horizontalRays === 1
                    ? 0
                    : horizontalIndex /
                      horizontalRays;

            const horizontalRadians =
                Cesium.Math.toRadians(
                    heading
                ) +
                horizontalFraction *
                Cesium.Math.toRadians(
                    horizontalAngle
                );

            /*
             * Vertical rays.
             *
             * For verticalRays = 1,
             * use the center of the vertical angle.
             */
            for (
                let verticalIndex = 0;
                verticalIndex < verticalRays;
                verticalIndex++
            ) {

                const verticalFraction =
                    verticalRays === 1
                        ? 0.5
                        : verticalIndex /
                          (verticalRays - 1);

                const verticalDegrees =
                    -verticalAngle / 2 +
                    verticalFraction *
                    verticalAngle;

                const verticalRadians =
                    Cesium.Math.toRadians(
                        verticalDegrees
                    );

                /*
                 * Local ENU direction.
                 *
                 * horizontal:
                 *   X = East
                 *   Y = North
                 *
                 * vertical:
                 *   Z = Up
                 */
                const horizontalCos =
                    Math.cos(verticalRadians);

                const localDirection =
                    new Cesium.Cartesian3(

                        Math.sin(horizontalRadians) *
                        horizontalCos,

                        Math.cos(horizontalRadians) *
                        horizontalCos,

                        Math.sin(verticalRadians)
                    );

                /*
                 * Convert ENU direction to world direction.
                 */
                const worldDirection =
                    Cesium.Matrix4.multiplyByPointAsVector(
                        enuTransform,
                        localDirection,
                        new Cesium.Cartesian3()
                    );

                Cesium.Cartesian3.normalize(
                    worldDirection,
                    worldDirection
                );

                rays.push(
                    new Cesium.Ray(
                        radarPosition,
                        worldDirection
                    )
                );
            }
        }

        /*
         * Results.
         */
        const results:
            RadarTerrainRayResult[] = [];

        /*
         * Process every ray.
         */
        for (const ray of rays) {

            /*
             * Create Cartographic sample points
             * along this ray.
             *
             * We DON'T sample Cartesian points directly.
             *
             * Terrain sampling needs:
             * longitude + latitude.
             */
            const cartographics:
                Cesium.Cartographic[] = [];

            /*
             * Keep the corresponding distance
             * along the ray.
             */
            const distances: number[] = [];

            for (
                let i = 0;
                i < sampleCount;
                i++
            ) {

                const distance =
                    Math.min(
                        i * sampleSpacing,
                        range
                    );

                const position =
                    Cesium.Ray.getPoint(
                        ray,
                        distance,
                        new Cesium.Cartesian3()
                    );

                const cartographic =
                    Cesium.Cartographic.fromCartesian(
                        position
                    );

                cartographics.push(
                    cartographic
                );

                distances.push(distance);
            }

            /*
             * Ask Cesium for terrain heights.
             */
            let sampledTerrain:
                Cesium.Cartographic[];

            try {

                sampledTerrain =
                    await Cesium.sampleTerrainMostDetailed(
                        terrainProvider,
                        cartographics
                    );

            } catch (error) {

                console.error(
                    "Radar terrain sampling failed:",
                    error
                );

                /*
                 * If terrain sampling fails,
                 * let this ray go to maximum range.
                 */
                results.push({
                    endPosition:
                        Cesium.Ray.getPoint(
                            ray,
                            range,
                            new Cesium.Cartesian3()
                        ),
                    blocked: false
                });

                continue;
            }

            /*
             * Find FIRST terrain intersection.
             */
            let blocked = false;

            let endPosition =
                Cesium.Ray.getPoint(
                    ray,
                    range,
                    new Cesium.Cartesian3()
                );

            for (
                let i = 0;
                i < sampledTerrain.length;
                i++
            ) {

                const terrainPoint =
                    sampledTerrain[i];

                const terrainHeight =
                    terrainPoint.height;

                if (
                    terrainHeight === undefined ||
                    terrainHeight === null ||
                    !Number.isFinite(terrainHeight)
                ) {
                    continue;
                }

                /*
                 * Ray position at this distance.
                 */
                const distance =
                    distances[i];

                const rayPosition =
                    Cesium.Ray.getPoint(
                        ray,
                        distance,
                        new Cesium.Cartesian3()
                    );

                /*
                 * Height of the radar ray above
                 * the ellipsoid.
                 */
                const rayCartographic =
                    Cesium.Cartographic.fromCartesian(
                        rayPosition
                    );

                const rayHeight =
                    rayCartographic.height;

                /*
                 * TERRAIN BLOCKS THE RAY.
                 *
                 * Terrain is at or above the
                 * ray height.
                 */
                if (
                    terrainHeight >= rayHeight
                ) {

                    /*
                     * We found the FIRST blocking
                     * terrain sample.
                     */
                    blocked = true;

                    /*
                     * Don't draw beyond this point.
                     */
                    endPosition =
                        Cesium.Cartesian3.fromRadians(
                            terrainPoint.longitude,
                            terrainPoint.latitude,
                            terrainHeight
                        );

                    break;
                }
            }

            /*
             * IMPORTANT:
             *
             * Only ONE endpoint is returned.
             *
             * If blocked:
             *
             *     radar → first mountain
             *
             * If not blocked:
             *
             *     radar → maximum range
             */
            results.push({
                endPosition,
                blocked
            });
        }

        return results;
    }
}