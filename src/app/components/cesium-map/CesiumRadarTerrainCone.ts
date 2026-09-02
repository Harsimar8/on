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

    private static readonly RAY_BATCH_SIZE = 8;

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

        const rays = this.generateRays(
            radarPosition,
            options.heading,
            options.horizontalAngle,
            options.verticalAngle,
            horizontalRays,
            verticalRays
        );

        const results: RayResult[] = [];

        /*
         * Do not fire hundreds of terrain operations
         * simultaneously.
         */
        for (
            let i = 0;
            i < rays.length;
            i += this.RAY_BATCH_SIZE
        ) {

            const batch =
                rays.slice(
                    i,
                    i + this.RAY_BATCH_SIZE
                );

            const batchResults =
                await Promise.all(
                    batch.map(ray =>
                        this.calculateSingleRay(
                            viewer,
                            ray,
                            options.range
                        )
                    )
                );

            results.push(...batchResults);
        }

        return results;
    }

    private static async calculateSingleRay(
        viewer: Cesium.Viewer,
        ray: RadarRay,
        range: number
    ): Promise<RayResult> {

        /*
         * FIRST try Cesium's actual terrain intersection.
         */
        const hit =
            this.getTerrainHit(
                viewer,
                ray,
                range
            );

        if (hit) {

            return {
                ray,
                distance: hit.distance,
                endPosition: hit.position,
                blocked: true
            };
        }

        /*
         * No terrain in front of the ray.
         * Therefore it travels the complete range.
         */
        const end =
            Cesium.Ray.getPoint(
                new Cesium.Ray(
                    ray.start,
                    ray.direction
                ),
                range
            );

        return {
            ray,
            distance: range,
            endPosition: end,
            blocked: false
        };
    }

    /*
     * Find the FIRST terrain intersection.
     */
    private static getTerrainHit(
        viewer: Cesium.Viewer,
        radarRay: RadarRay,
        maxRange: number
    ): {
        position: Cesium.Cartesian3;
        distance: number;
    } | null {

        const scene = viewer.scene;

        const ray =
            new Cesium.Ray(
                radarRay.start,
                radarRay.direction
            );

        /*
         * Cesium intersects the ray with the
         * currently rendered terrain.
         */
        const hit =
            scene.globe.pick(
                ray,
                scene
            );

        if (!hit) {
            return null;
        }

        /*
         * Distance from radar to terrain.
         */
        const distance =
            Cesium.Cartesian3.distance(
                radarRay.start,
                hit
            );

        /*
         * Ignore anything behind the radar
         * or outside the radar range.
         */
        if (
            distance <= 0 ||
            distance > maxRange
        ) {
            return null;
        }

        return {
            position: hit,
            distance
        };
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
            Cesium.Math.toRadians(heading);

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
             * IMPORTANT:
             *
             * Do not duplicate the 360-degree
             * starting ray at the end.
             */
            const horizontalT =
                horizontalRays === 1
                    ? 0.5
                    : h / horizontalRays;

            const azimuth =
                headingRad -
                halfHorizontal +
                horizontalT *
                Cesium.Math.toRadians(
                    horizontalAngle
                );

            for (
                let v = 0;
                v < verticalRays;
                v++
            ) {

                const verticalT =
                    verticalRays === 1
                        ? 0.5
                        : v / (
                            verticalRays - 1
                        );

                const elevation =
                    -halfVertical +
                    verticalT *
                    halfVertical *
                    2;

                /*
                 * Local ENU direction.
                 */
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