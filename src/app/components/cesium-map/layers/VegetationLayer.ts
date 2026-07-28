import * as Cesium from "cesium";

export class VegetationLayer {

    static async load(
        viewer: Cesium.Viewer,
        isPointInPolygon: (
            point: Cesium.Cartographic,
            polygon: Cesium.Cartographic[]
        ) => boolean
    ): Promise<void> {

        const vegetationDataSource =
            await Cesium.GeoJsonDataSource.load(
                "assets/data/vegetation.geojson",
                {
                    clampToGround: true
                }
            );

        vegetationDataSource.entities.values.forEach(entity => {

            if (!entity.polygon) return;

            const landuse =
                entity.properties?.["landuse"]?.getValue();

            const natural =
                entity.properties?.["natural"]?.getValue();

            const leisure =
                entity.properties?.["leisure"]?.getValue();

            // Ignore everything except vegetation
            if (
                natural !== "wood" &&
                landuse !== "forest" &&
                leisure !== "park" &&
                leisure !== "garden"
            ) {
                entity.show = false;
                return;
            }

            // ----------------------------
            // Random realistic colors
            // ----------------------------

            const color =
                Cesium.Color.fromCssColorString(
                    "#3B7A3A"   // Jaipur vegetation green
                )
                    .withAlpha(0.55);


            entity.polygon.material =
                new Cesium.ColorMaterialProperty(color);
            entity.polygon.outline =
                new Cesium.ConstantProperty(false);

            entity.polygon.classificationType =
                new Cesium.ConstantProperty(
                    Cesium.ClassificationType.TERRAIN
                );

        });
        const treeDataSource = new Cesium.CustomDataSource("Trees");

        const treeModel = "assets/models/tree.glb";
        viewer.dataSources.add(vegetationDataSource);
        viewer.dataSources.add(treeDataSource);
        let treeCount = 0;
        const MAX_TREES = 1500;


        for (const entity of vegetationDataSource.entities.values) {


            if (treeCount >= MAX_TREES)
                break;


            if (!entity.polygon)
                continue;


            const hierarchy =
                entity.polygon.hierarchy?.getValue(
                    Cesium.JulianDate.now()
                );


            if (!hierarchy)
    continue;

const positions = hierarchy.positions;

if (positions.length < 4)
    continue;

const polygon = positions.map(
    (position: Cesium.Cartesian3) =>
        Cesium.Cartographic.fromCartesian(position)
);

// 4 trees per vegetation polygon
const treePerPolygon = Math.min(
    20,
    Math.max(
        2,
        Math.floor(positions.length / 5)
    )
);

for (let i = 0; i < treePerPolygon; i++) {

    const randomPoint =
        VegetationLayer.randomPointInPolygon(
            polygon,
            isPointInPolygon
        );

    if (!randomPoint) {
        continue;
    }

    await VegetationLayer.addTree(
        viewer,
        treeDataSource,
        treeModel,
        Cesium.Math.toDegrees(randomPoint.longitude),
        Cesium.Math.toDegrees(randomPoint.latitude)
    );

    treeCount++;

    if (treeCount >= MAX_TREES) {
        break;
    }
}


            treeCount++;

        }

    }

    private static randomPointInPolygon(
        polygon: Cesium.Cartographic[],
        isPointInPolygon: (
            point: Cesium.Cartographic,
            polygon: Cesium.Cartographic[]
        ) => boolean
    ): Cesium.Cartographic | null {

        const lons = polygon.map(p => p.longitude);
        const lats = polygon.map(p => p.latitude);

        const minLon = Math.min(...lons);
        const maxLon = Math.max(...lons);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);

        for (let i = 0; i < 30; i++) {

            const point = new Cesium.Cartographic(
                Cesium.Math.lerp(minLon, maxLon, Math.random()),
                Cesium.Math.lerp(minLat, maxLat, Math.random()),
                0
            );

            if (isPointInPolygon(point, polygon)) {
                return point;
            }
        }

        return null;
    }
    private static async addTree(
        viewer: Cesium.Viewer,
        treeDataSource: Cesium.CustomDataSource,
        treeModel: string,
        lon: number,
        lat: number
    ): Promise<void> {

        const cartographic = Cesium.Cartographic.fromDegrees(
            lon,
            lat
        );

        const result = await Cesium.sampleTerrainMostDetailed(
            viewer.terrainProvider,
            [cartographic]
        );

        const terrainPoint = result[0];

        treeDataSource.entities.add({

            position: Cesium.Cartesian3.fromRadians(
                terrainPoint.longitude,
                terrainPoint.latitude,
                terrainPoint.height
            ),

            model: {
                uri: treeModel,
                scale: 2,
                minimumPixelSize: 32
            }

        });

    }

}