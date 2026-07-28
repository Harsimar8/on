import * as Cesium from "cesium";

export class BuildingLayer {

    static async load(viewer: Cesium.Viewer): Promise<void> {


        const buildings =
            await Cesium.GeoJsonDataSource.load(
                "assets/data/buildings.geojson",
                {
                    clampToGround: false
                }
            );


        // MAKE BUILDINGS VISIBLE
        const entities = buildings.entities.values;


        const positions: Cesium.Cartographic[] = [];


        entities.forEach(entity => {

            if (!entity.polygon) return;


            const hierarchy =
                entity.polygon.hierarchy?.getValue(
                    Cesium.JulianDate.now()
                );


            if (!hierarchy) return;


            const center =
                Cesium.BoundingSphere.fromPoints(
                    hierarchy.positions
                ).center;


            positions.push(
                Cesium.Cartographic.fromCartesian(center)
            );

        });



        const terrainPositions =
            await Cesium.sampleTerrainMostDetailed(
                viewer.terrainProvider,
                positions
            );



        let i = 0;


        entities.forEach(entity => {

            if (!entity.polygon) return;


            const groundHeight =
                terrainPositions[i]?.height ?? 0;


            i++;


            const buildingHeight =
                BuildingLayer.getBuildingHeight(entity);


            entity.polygon.height =
                new Cesium.ConstantProperty(
                    groundHeight
                );


            entity.polygon.extrudedHeight =
                new Cesium.ConstantProperty(
                    groundHeight + buildingHeight
                );


            entity.polygon.material =
                new Cesium.ColorMaterialProperty(
                    Cesium.Color.BISQUE.withAlpha(0.8)
                );


            entity.polygon.outline =
                new Cesium.ConstantProperty(true);


            entity.polygon.outlineColor =
                new Cesium.ConstantProperty(
                    Cesium.Color.BLACK
                );

        });



        viewer.dataSources.add(buildings);

        const hoverLabel = viewer.entities.add({

    label: {

        text: "",

        font: "14px sans-serif",

        fillColor: Cesium.Color.WHITE,

        showBackground: true,

        backgroundColor:
            Cesium.Color.BLACK.withAlpha(0.8),

        pixelOffset:
            new Cesium.Cartesian2(0, -40),

        verticalOrigin:
            Cesium.VerticalOrigin.BOTTOM,

        show:
            new Cesium.ConstantProperty(false),

        disableDepthTestDistance:
            Number.POSITIVE_INFINITY
    }

});



const handler =
    new Cesium.ScreenSpaceEventHandler(
        viewer.scene.canvas
    );



handler.setInputAction(
    (movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {


        const picked =
            viewer.scene.pick(
                movement.endPosition
            );


        if (
            Cesium.defined(picked) &&
            picked.id &&
            picked.id.polygon
        ) {


            const entity =
                picked.id;



            const properties =
                entity.properties;



            let text = "Building";


            if(properties){


                const name =
                    properties["name"]
                    ?.getValue();


                const type =
                    properties["building"]
                    ?.getValue();


                const tourism =
                    properties["tourism"]
                    ?.getValue();


                const office =
                    properties["office"]
                    ?.getValue();



                text =
                    name ??
                    tourism ??
                    office ??
                    type ??
                    "Building";


            }



            const hierarchy =
                entity.polygon!.hierarchy!
                .getValue(
                    Cesium.JulianDate.now()
                );



            const center =
                Cesium.BoundingSphere
                .fromPoints(
                    hierarchy.positions
                )
                .center;



            hoverLabel.position =
    new Cesium.ConstantPositionProperty(center);



            hoverLabel.label!.text =
                new Cesium.ConstantProperty(
                    text
                );



            hoverLabel.label!.show =
                new Cesium.ConstantProperty(
                    true
                );



            return;

        }



        hoverLabel.label!.show =
            new Cesium.ConstantProperty(false);


    },
    Cesium.ScreenSpaceEventType.MOUSE_MOVE
);
        // MOVE CAMERA TO BUILDINGS
        await viewer.flyTo(buildings);



        viewer.scene.globe.enableLighting = true;


        viewer.scene.fog.enabled = true;

        viewer.scene.fog.density = 0.00015;


        viewer.scene.globe.depthTestAgainstTerrain = false;


        viewer.scene.msaaSamples = 4;

        viewer.resolutionScale = 1.2;

    }

    private static getBuildingHeight(
        entity: Cesium.Entity
    ): number {


        const properties = entity.properties;


        // 1. Known OSM types

        if (
            properties &&
            properties["tourism"]?.getValue() === "hotel"
        ) {
            return 35;
        }


        if (
            properties &&
            (
                properties["office"]?.getValue() ||
                properties["government"]?.getValue()
            )
        ) {
            return 25;
        }


        if (
            properties &&
            properties["historic"]?.getValue()
        ) {
            return 15;
        }



        // 2. Estimate from building footprint size

        if (entity.polygon) {


            const hierarchy =
                entity.polygon.hierarchy?.getValue(
                    Cesium.JulianDate.now()
                );


            if (hierarchy) {


                const positions =
                    hierarchy.positions;
                

                const area =
                    BuildingLayer.calculatePolygonArea(positions);


                // Large footprint
                if (area > 5000) {
                    return 35;
                }


                // Medium footprint
                if (area > 1000) {
                    return 20;
                }


                // Small houses
                return 8;

            }

        }



        // fallback

        return 10;

    }
    private static calculatePolygonArea(
        positions: Cesium.Cartesian3[]
    ): number {

        let area = 0;


        for (let i = 0; i < positions.length; i++) {

            const p1 =
                Cesium.Cartographic.fromCartesian(
                    positions[i]
                );


            const p2 =
                Cesium.Cartographic.fromCartesian(
                    positions[
                    (i + 1) % positions.length
                    ]
                );


            const x1 =
                Cesium.Math.toDegrees(p1.longitude);

            const y1 =
                Cesium.Math.toDegrees(p1.latitude);


            const x2 =
                Cesium.Math.toDegrees(p2.longitude);

            const y2 =
                Cesium.Math.toDegrees(p2.latitude);


            area +=
                (x1 * y2) -
                (x2 * y1);

        }


        return Math.abs(area) * 1000000;
    }


}